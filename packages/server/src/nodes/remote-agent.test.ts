import { describe, expect, it } from 'vitest';
import type { PathMapping } from '@trawlarr/core';
import type { DocumentPort } from '@trawlarr/engine';
import { AgentFailure } from '../worker/agent-handle.js';
import type { JobPayload } from '../worker/job-payload.js';
import type { JobReport } from '../worker/run-payload.js';
import { payloadToNode } from './map-payload.js';
import type { ServerFrame } from './node-frames.js';
import { createRemoteAgentHandle, type RemoteAgentInput } from './remote-agent.js';

const SERVER_NOW = 1_700_000_000_000;

const MAP: PathMapping[] = [{ serverPath: '/media', nodePath: '/mnt/nas' }];

const payloadFixture = (): JobPayload =>
  ({
    jobId: 'job-1',
    fileId: 'file-1',
    libraryId: 'lib-1',
    path: '/media/movies/a.mkv',
    library: {
      id: 'lib-1',
      name: 'Movies',
      roots: ['/media/movies'],
      stagingDir: null,
      trashDir: null,
    },
    flow: { id: 'flow-1', definition: { nodes: [], edges: [] }, definitionHash: 'h' },
    logPath: '/data/logs/jobs/job-1.log',
    pluginPaths: {},
    pluginBundles: {},
  }) as unknown as JobPayload;

const reportFixture = (path: string): JobReport =>
  ({
    jobId: 'job-1',
    fileId: 'file-1',
    steps: [],
    stopReason: 'end-of-flow',
    failed: false,
    error: null,
    success: true,
    outcome: 'ok',
    replaced: {
      path,
      container: 'mkv',
      sizeBytes: 1,
      mtimeMs: 1,
      ctimeMs: 1,
      nlink: 1,
      // The NODE's own stat: its NFS client's anonymous device number.
      deviceId: 9_999,
      inode: 4_242,
      hash: { sizeBytes: 1, headHex: 'nodehead', tailHex: 'nodetail' },
      probe: null,
      probeError: null,
    },
    preFacts: {},
    postFacts: null,
    cancelled: false,
  }) as unknown as JobReport;

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const noDocuments: DocumentPort = {
  get: () => undefined,
  insert: () => {},
  update: () => {},
  removeOne: () => {},
};

/** What the SERVER sees when it stats a replaced path through its own mount. */
const SERVER_STAT = {
  dev: 66,
  ino: 1_234,
  nlink: 1,
  mtimeMs: 111,
  ctimeMs: 222,
  size: 4_096,
};

const harness = (over: Partial<RemoteAgentInput> = {}) => {
  const sent: ServerFrame[] = [];
  const statted: string[] = [];
  const setRemoteCalls: Parameters<RemoteAgentInput['jobs']['setRemote']>[0][] = [];
  const cancelRequests: { jobId: string; nowMs: number }[] = [];
  const heartbeats: number[] = [];
  const state = { online: true, decision: { granted: true, reason: null as string | null } };
  const handle = createRemoteAgentHandle({
    id: 'worker-1',
    nodeId: 'node-a',
    fresh: true,
    documents: noDocuments,
    onStep: () => {},
    onHeartbeat: (at) => {
      heartbeats.push(at);
    },
    onProgress: () => {},
    onLog: () => {},
    nowMs: () => SERVER_NOW,
    jobs: {
      setRemote: (input) => {
        setRemoteCalls.push(input);
      },
      requestCancel: (input) => {
        cancelRequests.push(input);
      },
    },
    channel: () =>
      state.online
        ? {
            send: (frame) => {
              sent.push(frame);
              return true;
            },
          }
        : null,
    decideCommit: () => state.decision,
    onStepLease: () => {},
    prepare: (payload) =>
      Promise.resolve({
        payload: payloadToNode(
          { ...payload, pluginBundles: { 'a:b': { bundle: 'sha', relPath: 'p/index.js' } } },
          MAP,
        ),
        pathMap: MAP,
      }),
    appendLog: () => {},
    statPath: (path) => {
      statted.push(path);
      return Promise.resolve(SERVER_STAT);
    },
    ...over,
  });
  return { handle, sent, setRemoteCalls, state, cancelRequests, heartbeats, statted };
};

describe('createRemoteAgentHandle', () => {
  it('sends exactly one mapped job frame with bundles, after recording a connected lease and the server-view payload', async () => {
    const { handle, sent, setRemoteCalls } = harness();
    void handle.run(payloadFixture());
    await flush();

    expect(sent).toHaveLength(1);
    const frame = sent[0] as Extract<ServerFrame, { type: 'job' }>;
    expect(frame.type).toBe('job');
    expect(frame.payload.path).toBe('/mnt/nas/movies/a.mkv');
    expect(frame.payload.library.roots).toEqual(['/mnt/nas/movies']);
    expect(frame.payload.pluginBundles).toEqual({
      'a:b': { bundle: 'sha', relPath: 'p/index.js' },
    });

    expect(setRemoteCalls).toHaveLength(1);
    expect(setRemoteCalls[0]).toMatchObject({
      jobId: 'job-1',
      nodeId: 'node-a',
      lease: { state: 'connected', expiresAtMs: null },
      pathMapJson: JSON.stringify(MAP),
    });
    expect((JSON.parse(setRemoteCalls[0]!.payloadJson) as JobPayload).path).toBe(
      '/media/movies/a.mkv',
    );
  });

  it('rejects as a reported failure when prepare throws, and sends nothing', async () => {
    const { handle, sent, setRemoteCalls } = harness({
      prepare: () =>
        Promise.reject(new Error('Path "/elsewhere" is outside the node\'s path map.')),
    });
    const error = await handle.run(payloadFixture()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentFailure);
    expect((error as AgentFailure).reported).toBe(true);
    expect((error as AgentFailure).message).toContain('outside the node');
    expect(sent).toEqual([]);
    expect(setRemoteCalls).toEqual([]);
  });

  it('resolves done with the report mapped back to server paths', async () => {
    const { handle } = harness();
    const run = handle.run(payloadFixture());
    await flush();
    handle.receive({ type: 'done', report: reportFixture('/mnt/nas/movies/a.mkv') });
    const report = await run;
    expect(report.replaced?.path).toBe('/media/movies/a.mkv');
  });

  it("replaces the node's device/inode/stat with the server's own stat of the mapped path, keeping hash and probe", async () => {
    // Device numbers are per-host: an NFS client's anonymous st_dev never
    // equals the server's, so a report carrying the node's identity would
    // read as "the file changed" even for a Replace that swapped nothing.
    const { handle, statted } = harness();
    const run = handle.run(payloadFixture());
    await flush();
    handle.receive({ type: 'done', report: reportFixture('/mnt/nas/movies/a.mkv') });
    const report = await run;
    expect(statted).toEqual(['/media/movies/a.mkv']);
    expect(report.replaced).toMatchObject({
      path: '/media/movies/a.mkv',
      deviceId: 66,
      inode: 1_234,
      nlink: 1,
      mtimeMs: 111,
      ctimeMs: 222,
      sizeBytes: 4_096,
      hash: { sizeBytes: 1, headHex: 'nodehead', tailHex: 'nodetail' },
      probe: null,
    });
  });

  it('rejects as a reported failure naming the path when the server cannot stat the replaced file', async () => {
    const { handle } = harness({
      statPath: () => Promise.reject(new Error('ENOENT: no such file or directory')),
    });
    const run = handle.run(payloadFixture());
    await flush();
    handle.receive({ type: 'done', report: reportFixture('/mnt/nas/movies/a.mkv') });
    const error = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentFailure);
    expect(error).toMatchObject({ reported: true });
    expect((error as Error).message).toContain('/media/movies/a.mkv');
  });

  it('sends commit-result granted:false when the decision refuses', async () => {
    const { handle, sent, state } = harness();
    void handle.run(payloadFixture());
    await flush();
    state.decision = { granted: false, reason: 'lease expired' };
    handle.receive({ type: 'commit-request', id: 7, kind: 'replace', pluginId: 'x' });
    expect(sent.at(-1)).toEqual({
      type: 'agent',
      jobId: 'job-1',
      message: { type: 'commit-result', id: 7, granted: false, reason: 'lease expired' },
    });
  });

  it('refuses a commit once cancelled, even when the lease would grant it', async () => {
    const { handle, sent, state } = harness();
    void handle.run(payloadFixture()).catch(() => {});
    await flush();
    state.online = false;
    handle.cancel();
    state.online = true;
    handle.receive({ type: 'commit-request', id: 3, kind: 'replace', pluginId: 'x' });
    const commit = sent.find(
      (frame) => frame.type === 'agent' && frame.message.type === 'commit-result',
    ) as Extract<ServerFrame, { type: 'agent' }>;
    expect(commit.message).toMatchObject({ type: 'commit-result', id: 3, granted: false });
  });

  it('delivers a cancel made while offline once reconnected', async () => {
    const { handle, sent, state } = harness();
    void handle.run(payloadFixture()).catch(() => {});
    await flush();
    state.online = false;
    handle.cancel();
    expect(sent.filter((frame) => frame.type === 'agent')).toEqual([]);

    state.online = true;
    handle.reconnected();
    expect(sent.at(-1)).toEqual({ type: 'agent', jobId: 'job-1', message: { type: 'cancel' } });

    // Flushed once, not on every later reconnect.
    handle.reconnected();
    expect(sent.filter((frame) => frame.type === 'agent')).toHaveLength(1);
  });

  it('rejects once on abandon, tells the node, and ignores a later done', async () => {
    const { handle, sent } = harness();
    const run = handle.run(payloadFixture());
    await flush();
    handle.abandon(new AgentFailure('released', { reported: false }));
    await expect(run).rejects.toMatchObject({ message: 'released', reported: false });
    expect(sent.at(-1)).toEqual({ type: 'abandon', jobId: 'job-1', reason: 'released' });

    handle.receive({ type: 'done', report: reportFixture('/mnt/nas/movies/a.mkv') });
    handle.abandon(new AgentFailure('again', { reported: false }));
    expect(sent.filter((frame) => frame.type === 'abandon')).toHaveLength(1);
    await expect(handle.exited).resolves.toBeNull();
  });

  it('carries cancelled on an abandon after a cancel made while offline, so the release spends no attempt', async () => {
    // Cancelled while the node was away, then grace ran out: that is still
    // the operator's decision, not a stall of the file.
    const { handle, state } = harness();
    const run = handle.run(payloadFixture());
    await flush();
    state.online = false;
    handle.cancel();
    handle.abandon(new AgentFailure('grace window ran out', { reported: false }));
    await expect(run).rejects.toMatchObject({
      message: 'grace window ran out',
      cancelled: true,
      reported: false,
    });
  });

  it('carries cancelled on an abandon of an adopted job whose row was cancelled', async () => {
    const { handle } = harness({ fresh: false, pathMap: MAP, cancelRequested: true });
    handle.abandon(new AgentFailure('already released', { reported: false }));
    await expect(handle.run(payloadFixture())).rejects.toMatchObject({ cancelled: true });
  });

  it('settled() sends ack-report', async () => {
    const { handle, sent } = harness();
    const run = handle.run(payloadFixture());
    await flush();
    handle.receive({ type: 'done', report: reportFixture('/mnt/nas/movies/a.mkv') });
    await run;
    handle.settled?.();
    expect(sent.at(-1)).toEqual({ type: 'ack-report', jobId: 'job-1' });
  });

  it('an adopted handle sends nothing on run and reports through its stored map', async () => {
    const { handle, sent, setRemoteCalls } = harness({ fresh: false, pathMap: MAP });
    const run = handle.run(payloadFixture());
    await flush();
    expect(sent).toEqual([]);
    expect(setRemoteCalls).toEqual([]);
    handle.receive({ type: 'done', report: reportFixture('/mnt/nas/movies/a.mkv') });
    expect((await run).replaced?.path).toBe('/media/movies/a.mkv');
  });

  it('marks a superseded report cancelled when this handle was cancelled, as a failed frame would be', async () => {
    // The node's commit can be refused for the cancel before the cancel frame
    // itself reaches it: its report then says superseded, not cancelled, and
    // folding that as a superseded stall would spend an attempt on the
    // operator's decision.
    const { handle, state } = harness();
    const run = handle.run(payloadFixture());
    await flush();
    state.online = false;
    handle.cancel();
    handle.receive({
      type: 'done',
      report: { ...reportFixture('/mnt/nas/movies/a.mkv'), failed: true, superseded: true },
    });
    expect((await run).cancelled).toBe(true);
  });

  it('a failed frame rejects as reported, carrying superseded', async () => {
    const { handle } = harness();
    const run = handle.run(payloadFixture());
    await flush();
    handle.receive({ type: 'failed', error: 'refused', superseded: true });
    await expect(run).rejects.toMatchObject({ reported: true, superseded: true });
  });
  it("stamps a heartbeat with the server clock, never the node's own", async () => {
    // The 24 h floor compares heartbeat_at against the SERVER clock; a node
    // whose clock is a day behind would otherwise be released on first sweep.
    const { handle, heartbeats } = harness();
    void handle.run(payloadFixture());
    await flush();
    handle.receive({ type: 'heartbeat', nowMs: 5 });
    expect(heartbeats).toEqual([SERVER_NOW]);
  });

  it('settles run as a reported failure when recording the lease throws, sending nothing', async () => {
    const { handle, sent } = harness({
      jobs: {
        setRemote: () => {
          throw new Error('database is locked');
        },
        requestCancel: () => {},
      },
    });
    const error = await handle.run(payloadFixture()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentFailure);
    expect(error).toMatchObject({ reported: true });
    expect((error as Error).message).toContain('database is locked');
    expect(sent).toEqual([]);
  });

  it('persists a cancel on the job row, so a daemon restart cannot forget it', async () => {
    const { handle, cancelRequests, state } = harness();
    void handle.run(payloadFixture()).catch(() => {});
    await flush();
    state.online = false;
    handle.kill();
    expect(cancelRequests).toEqual([{ jobId: 'job-1', nowMs: SERVER_NOW }]);
  });

  it('an adopted handle whose row was cancelled sends cancel on reconnect and refuses commits', async () => {
    const { handle, sent, state } = harness({ fresh: false, pathMap: MAP, cancelRequested: true });
    state.online = false;
    void handle.run(payloadFixture()).catch(() => {});
    await flush();
    state.online = true;
    handle.reconnected();
    expect(sent).toEqual([{ type: 'agent', jobId: 'job-1', message: { type: 'cancel' } }]);
    handle.receive({ type: 'commit-request', id: 2, kind: 'replace', pluginId: 'x' });
    expect(sent.at(-1)).toMatchObject({ message: { type: 'commit-result', granted: false } });
  });
});
