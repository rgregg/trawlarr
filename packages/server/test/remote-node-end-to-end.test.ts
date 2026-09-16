import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import SqliteDatabase from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createSettingsRepo } from '../src/db/settings-repo.js';
import type { TrawlarrEvent } from '../src/daemon/events.js';
import { PROTOCOL_VERSION } from '../src/worker/protocol.js';
import { ffmpegAvailableSync } from '../../../test-support/tool-availability.js';
import { CORPUS_DIR, corpusAvailable } from '../../engine/test/compat/corpus.js';
import {
  BUILT_CLI_PATH,
  spawnDaemonProcess,
  spawnNodeProcess,
  startTcpProxy,
  until,
  type DaemonProcess,
  type SpawnedProcess,
  type TcpProxy,
} from './helpers/daemon-harness.js';

const execFileAsync = promisify(execFile);

/**
 * A REMOTE NODE NEVER COSTS A FILE.
 *
 * A real built daemon and a real `trawlarr node` process, talking over
 * loopback through a TCP proxy this suite can cut, running real ffmpeg on
 * media generated here. The node sees the library through a second path (a
 * symlink to the server's root) and a path map, so every path that crosses
 * the wire is translated both ways, and a report that came back in node view
 * would name a directory the server's rows must never contain.
 *
 * The cases are the guarantees in the remote-nodes spec's error-handling
 * table, each asserted on the facts that make it safe — the bytes of the
 * original file, the ledger row, the job row, the node's journal and staging
 * directory — never on "no error".
 *
 * TWO THINGS HERE ARE NOT THE PRODUCT'S DEFAULTS, and both are on purpose:
 *
 *  - The node runs ffmpeg through a wrapper that adds `-re`, so an encode of
 *    an N-second clip takes about N seconds on any machine. "Sever the socket
 *    DURING Execute" is otherwise a race against however fast this CPU is.
 *    It is still real ffmpeg producing a real file.
 *  - The grace-expiry case starts its daemon with two test-only seams
 *    (`TRAWLARR_TEST_LEASE_SWEEP_MS`, `TRAWLARR_TEST_ALLOW_SHORT_GRACE`),
 *    both honoured only under `NODE_ENV=test`: a five-minute grace floor and
 *    a one-minute sweep would make that one case take six minutes.
 */

// Computed SYNCHRONOUSLY at collection time: a check behind an async
// `beforeAll` reads as unavailable and skips the suite, and a skipped suite
// is green. `ffmpegAvailableSync` answers false only for ENOENT and throws
// for every other failure.
const available = ffmpegAvailableSync();

const SERVER_SRC = join(process.cwd(), 'packages/server/src');

const newestMtimeMs = (dir: string): number => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs);
  }
  return newest;
};

/** Spawning a stale build would test yesterday's code; fail loudly instead. */
const assertBuiltCliIsFresh = (): void => {
  if (!existsSync(BUILT_CLI_PATH)) {
    throw new Error(`${BUILT_CLI_PATH} does not exist. Run "pnpm build" before this suite.`);
  }
  if (statSync(BUILT_CLI_PATH).mtimeMs < newestMtimeMs(SERVER_SRC)) {
    throw new Error(
      `${BUILT_CLI_PATH} is older than packages/server/src — this suite would run STALE ` +
        `compiled output. Run "pnpm exec tsc --build --force" first.`,
    );
  }
};

const sha256Of = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

/** An mpeg4 clip, so a libx264 flow really encodes it rather than skipping as already done. */
const makeSample = async (path: string, seconds: number): Promise<void> => {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${String(seconds)}:size=160x120:rate=25`,
    '-c:v', 'mpeg4', '-q:v', '5',
    path,
  ]); // prettier-ignore
};

const videoCodecOf = async (path: string): Promise<string> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0',
    path,
  ]); // prettier-ignore
  return stdout.trim();
};

const node = (id: string, pluginId: string, inputs: Record<string, string> = {}) => ({
  id,
  pluginId,
  pluginVersion: '1.0.0',
  inputs,
});

const chain = (ids: string[]) =>
  ids.slice(1).map((toNodeId, index) => ({ fromNodeId: ids[index]!, outputNumber: 1, toNodeId }));

/** Execute (libx264, same mkv container) → Verify → Replace Original File. */
const transcodeFlow: FlowDefinition = {
  nodes: [
    node('start', 'trawlarr:start'),
    node('begin', 'trawlarr:beginCommand'),
    node('encoder', 'trawlarr:setVideoEncoder', { encoder: 'libx264', quality: '35' }),
    node('execute', 'trawlarr:execute'),
    node('verify', 'trawlarr:verifyOutput', {
      durationToleranceSeconds: '1',
      minSizeRatio: '0.01',
    }),
    node('replace', 'trawlarr:replaceOriginal', {
      trashRetentionDays: '14',
      allowCrossDevice: 'true',
    }),
  ],
  edges: chain(['start', 'begin', 'encoder', 'execute', 'verify', 'replace']),
};

/**
 * The same encode with NO library write after it, so no step asks the server
 * for a commit. A run that has to install can never finish while its node is
 * offline — the commit waits for the server, by design — so this is the only
 * shape of job that can finish, and be held, with the socket down.
 */
const encodeOnlyFlow: FlowDefinition = {
  nodes: transcodeFlow.nodes.slice(0, 4),
  edges: chain(['start', 'begin', 'encoder', 'execute']),
};

/** Only an installed community plugin transforms the file: its bundle must reach the node. */
const communityRemuxFlow: FlowDefinition = {
  nodes: [
    node('start', 'trawlarr:start'),
    node('begin', 'trawlarr:beginCommand'),
    node('container', 'tdarr:ffmpegCommandSetContainer', {
      container: 'mp4',
      forceConform: 'true',
    }),
    node('execute', 'trawlarr:execute'),
    node('verify', 'trawlarr:verifyOutput', {
      durationToleranceSeconds: '1',
      minSizeRatio: '0.01',
    }),
    node('replace', 'trawlarr:replaceOriginal', {
      trashRetentionDays: '14',
      allowCrossDevice: 'true',
    }),
  ],
  edges: chain(['start', 'begin', 'container', 'execute', 'verify', 'replace']),
};

interface JobDbRow {
  id: string;
  file_id: string;
  node_id: string | null;
  state: string;
  outcome: string | null;
  lease_state: string | null;
  ended_at: number | null;
  cancel_requested_at: number | null;
}

interface FileDbRow {
  id: string;
  path: string;
  state: string;
  attempt_count: number;
  hold_until_ms: number | null;
}

interface NodeResource {
  id: string;
  online: boolean;
  revokedAt: number | null;
  enrolled: boolean;
}

interface Harness {
  workDir: string;
  lib: string;
  nodeview: string;
  nodeDataDir: string;
  daemon: DaemonProcess;
  proxy: TcpProxy;
  events: TrawlarrEvent[];
  nodeId: string;
  /** The node process currently running, if any. */
  nodeProcess: SpawnedProcess | null;
  /** (Re)starts the node process against the proxy. The token is used only on first start. */
  startNode(env?: Record<string, string>): SpawnedProcess;
  jobs(): JobDbRow[];
  files(): FileDbRow[];
  nodeResource(): Promise<NodeResource>;
  /** Waits for the only job to exist, nudging the supervisor so nothing waits on its 30 s tick. */
  firstJob(): Promise<JobDbRow>;
  job(id: string): JobDbRow;
  /** Waits for an encode to be genuinely under way on the node: ffmpeg reporting a percentage. */
  executeProgress(jobId: string): Promise<void>;
  journalEntries(): string[];
  journal(jobId: string): { state: string } | null;
  nodeLog(jobId: string): string;
  stagingEntries(): string[];
  describe(): string;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  // Reverse order: node before daemon before proxy. Every one runs even when
  // an earlier one throws — a daemon left behind would keep a temp tree busy
  // and a node left behind would keep encoding into it.
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
});

const setup = async (options: {
  files: { name: string; seconds: number }[];
  flow: FlowDefinition;
  /** Seconds of grace (with a fast sweep) instead of the product's hour. */
  shortGraceMs?: number;
  /** Install the plugin corpus as source "tdarr" before the daemon starts. */
  pluginSource?: boolean;
  /** Start the node process as part of setup (default true). */
  startNode?: boolean;
  nodeEnv?: Record<string, string>;
}): Promise<Harness> => {
  assertBuiltCliIsFresh();
  const workDir = mkdtempSync(join(tmpdir(), 'trawlarr-remote-e2e-'));
  const lib = join(workDir, 'lib');
  const nodeview = join(workDir, 'nodeview');
  const dataDir = join(workDir, 'data');
  const nodeDataDir = join(workDir, 'node-data');
  mkdirSync(lib);
  mkdirSync(dataDir);
  // The node's view of the same files at a different path. A symlink, not a
  // copy: a rename through it stays on one filesystem, as a bind mount would.
  symlinkSync(lib, nodeview);
  cleanups.push(() => {
    // Any ffmpeg still writing into this tree (a group that escaped every
    // stop) dies before the tree is removed.
    const ps = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    for (const line of ps.split('\n')) {
      if (!line.includes(workDir) || !/ffmpeg|ffprobe/.test(line)) continue;
      try {
        process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL');
      } catch {
        // gone
      }
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  for (const file of options.files) await makeSample(join(lib, file.name), file.seconds);

  // Real-time ffmpeg for the node: see the suite comment.
  const realFfmpeg = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
  const ffmpegWrapper = join(workDir, 'ffmpeg-realtime');
  writeFileSync(ffmpegWrapper, `#!/bin/sh\nexec "${realFfmpeg}" -re "$@"\n`, 'utf8');
  chmodSync(ffmpegWrapper, 0o755);

  // Written before the daemon opens its database, because it is what the
  // daemon starts with: no watcher or periodic rescan racing the test, and
  // NO local workers, so the only thing that can take a job is the node.
  {
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const settings = createSettingsRepo({ db });
    settings.setScan({ watchEnabled: false, rescanIntervalMs: 0, settleMs: 0 });
    settings.setSchedule({
      timezone: 'UTC',
      baseCounts: { transcode: 0, health: 0 },
      windows: [],
    });
    if (options.shortGraceMs !== undefined) {
      // The same seam the daemon is started with below; this process
      // validates the setting on write too.
      process.env.TRAWLARR_TEST_ALLOW_SHORT_GRACE = '1';
      try {
        settings.setNodes({ leaseGraceMs: options.shortGraceMs });
      } finally {
        delete process.env.TRAWLARR_TEST_ALLOW_SHORT_GRACE;
      }
    }
    db.close();
  }
  if (options.pluginSource === true) {
    const cli = async (args: string[]) =>
      await execFileAsync(process.execPath, [BUILT_CLI_PATH, ...args, '--data-dir', dataDir], {
        maxBuffer: 10 * 1024 * 1024,
      });
    await cli(['plugin', 'source', 'add', '--name', 'tdarr', '--path', CORPUS_DIR]);
    await cli(['plugin', 'source', 'sync', '--name', 'tdarr']);
  }

  const daemon = await spawnDaemonProcess({
    dataDir,
    env:
      options.shortGraceMs === undefined
        ? {}
        : { TRAWLARR_TEST_ALLOW_SHORT_GRACE: '1', TRAWLARR_TEST_LEASE_SWEEP_MS: '250' },
  });
  cleanups.push(async () => {
    await daemon.stop('SIGTERM', 15_000);
  });

  const proxy = await startTcpProxy(daemon.port);
  cleanups.push(async () => {
    await proxy.close();
  });

  const events: TrawlarrEvent[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${String(daemon.port)}/api/v1/events`, {
    headers: { 'x-api-key': daemon.apiKey },
  });
  socket.on('message', (data: Buffer) => {
    events.push(JSON.parse(data.toString('utf8')) as TrawlarrEvent);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  cleanups.push(() => {
    socket.close();
  });

  const reader = new SqliteDatabase(join(dataDir, 'trawlarr.db'), { readonly: true });
  cleanups.push(() => {
    reader.close();
  });

  const flow = await daemon.api<{ id: string }>('POST', '/flows', {
    name: 'Remote',
    definition: options.flow,
  });
  await daemon.api('POST', '/libraries', { name: 'Movies', roots: [lib], flowId: flow.id });

  const created = await daemon.api<{ node: { id: string }; enrollToken: string }>(
    'POST',
    '/nodes',
    { name: 'remote-one' },
  );
  const nodeId = created.node.id;
  await daemon.api('PUT', `/nodes/${nodeId}`, {
    pathMap: [{ serverPath: lib, nodePath: nodeview }],
    schedule: { timezone: 'UTC', baseCounts: { transcode: 1, health: 0 }, windows: [] },
  });

  const jobs = (): JobDbRow[] =>
    reader
      .prepare(
        `SELECT id, file_id, node_id, state, outcome, lease_state, ended_at, cancel_requested_at
           FROM job ORDER BY started_at, id`,
      )
      .all() as JobDbRow[];
  const files = (): FileDbRow[] =>
    reader
      .prepare(`SELECT id, path, state, attempt_count, hold_until_ms FROM media_file ORDER BY path`)
      .all() as FileDbRow[];

  const harness: Harness = {
    workDir,
    lib,
    nodeview,
    nodeDataDir,
    daemon,
    proxy,
    events,
    nodeId,
    nodeProcess: null,
    startNode: (env = {}) => {
      const spawned = spawnNodeProcess({
        dataDir: nodeDataDir,
        serverUrl: `http://127.0.0.1:${String(proxy.port)}`,
        token: existsSync(join(nodeDataDir, 'node.json')) ? undefined : created.enrollToken,
        ffmpegPath: ffmpegWrapper,
        env: { ...options.nodeEnv, ...env },
      });
      harness.nodeProcess = spawned;
      cleanups.push(async () => {
        await spawned.stop('SIGTERM', 10_000);
      });
      return spawned;
    },
    jobs,
    files,
    nodeResource: async () => {
      const all = await daemon.api<NodeResource[]>('GET', '/nodes');
      return all.find((entry) => entry.id === nodeId)!;
    },
    firstJob: async () => {
      let lastKick = 0;
      await until(
        'the node to be sent a job',
        async () => {
          if (jobs().length > 0) return true;
          if (Date.now() - lastKick > 1_000) {
            lastKick = Date.now();
            // Awaits a full supervisor tick; the local count stays zero.
            await daemon.api('PUT', '/workers/counts', { transcode: 0 });
          }
          return false;
        },
        { timeoutMs: 60_000, describe: () => harness.describe() },
      );
      return jobs()[0]!;
    },
    job: (id) => jobs().find((row) => row.id === id)!,
    executeProgress: async (jobId) => {
      await until(
        'ffmpeg on the node to report encode progress',
        () =>
          events.some(
            (event) =>
              event.type === 'job.progress' &&
              event.jobId === jobId &&
              event.percent !== null &&
              event.percent > 0,
          ),
        { timeoutMs: 60_000, describe: () => harness.describe() },
      );
    },
    journalEntries: () => {
      const dir = join(nodeDataDir, 'journal');
      return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
    },
    journal: (jobId) => {
      try {
        return JSON.parse(readFileSync(join(nodeDataDir, 'journal', `${jobId}.json`), 'utf8')) as {
          state: string;
        };
      } catch {
        return null;
      }
    },
    nodeLog: (jobId) => {
      try {
        return readFileSync(join(nodeDataDir, 'logs', 'jobs', `${jobId}.log`), 'utf8');
      } catch {
        return '';
      }
    },
    stagingEntries: () => {
      const dir = join(nodeview, '.trawlarr', 'staging');
      return existsSync(dir) ? readdirSync(dir) : [];
    },
    describe: () =>
      JSON.stringify({ jobs: jobs(), files: files() }, null, 2) +
      `\n--- node output ---\n${harness.nodeProcess?.output() ?? '(no node)'}` +
      `\n--- daemon output ---\n${daemon.output()}`,
  };

  if (options.startNode !== false) harness.startNode();
  return harness;
};

describe.runIf(available)('remote node end-to-end: a real daemon and a real node process', () => {
  it('completes a job through mapped paths, recording server-view paths and the node log', async () => {
    const h = await setup({ files: [{ name: 'a.mkv', seconds: 2 }], flow: transcodeFlow });
    const original = join(h.lib, 'a.mkv');
    expect(await videoCodecOf(original)).toBe('mpeg4');

    const job = await h.firstJob();
    await until('the job to end', () => h.job(job.id).ended_at !== null, {
      describe: () => h.describe(),
    });

    const ended = h.job(job.id);
    expect(ended.state).toBe('succeeded');
    expect(ended.node_id).toBe(h.nodeId);
    expect(h.jobs()).toHaveLength(1);

    // The replacement is on disk at the server's path, transcoded.
    expect(await videoCodecOf(original)).toBe('h264');
    const rows = h.files();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('good');
    // Recorded in SERVER view: a node-view path in a row names a directory
    // the server may not even have.
    expect(rows[0]!.path).toBe(original);
    expect(rows.some((row) => row.path.includes(h.nodeview))).toBe(false);

    // The server's copy of the job log carries lines the node wrote — the
    // ffmpeg command line names the node's own view of the file.
    const log = await h.daemon.api<{ text: string }>('GET', `/jobs/${job.id}/log`);
    expect(log.text).toContain(join(h.nodeview, 'a.mkv'));

    // And the node let go of everything: no held report, no staging left.
    await until('the node journal to empty', () => h.journalEntries().length === 0);
    expect(h.stagingEntries()).toEqual([]);
  }, 120_000);

  it('survives a connection blip mid-Execute: the lease waits in grace and the job completes', async () => {
    const h = await setup({ files: [{ name: 'a.mkv', seconds: 6 }], flow: transcodeFlow });
    const job = await h.firstJob();
    await h.executeProgress(job.id);

    h.proxy.pause();
    h.proxy.sever();
    // The daemon noticed: the claim is held in grace, not released, and the
    // node is offline.
    await until('the lease to move to grace', () => h.job(job.id).lease_state === 'grace', {
      describe: () => h.describe(),
    });
    expect((await h.nodeResource()).online).toBe(false);
    await sleep(2_000);
    const whileSevered = h.job(job.id);
    expect(whileSevered.lease_state).toBe('grace');
    expect(whileSevered.ended_at).toBeNull();
    expect(h.files()[0]!.state).toBe('running');
    h.proxy.resume();

    await until('the job to end after the node reconnects', () => h.job(job.id).ended_at !== null, {
      describe: () => h.describe(),
    });
    const ended = h.job(job.id);
    expect(ended.state).toBe('succeeded');
    expect(ended.node_id).toBe(h.nodeId);
    // One job for the one file: the blip did not cost an attempt or a re-run.
    expect(h.jobs()).toHaveLength(1);
    expect(h.files()).toEqual([expect.objectContaining({ state: 'good', attempt_count: 0 })]);
    expect(await videoCodecOf(join(h.lib, 'a.mkv'))).toBe('h264');
    expect(h.nodeProcess!.output()).toContain('Reconnected');
  }, 120_000);

  it('never installs over a file whose claim was released while the node was away', async () => {
    const h = await setup({
      files: [{ name: 'a.mkv', seconds: 5 }],
      flow: transcodeFlow,
      shortGraceMs: 1_500,
    });
    const original = join(h.lib, 'a.mkv');
    const originalHash = sha256Of(original);
    const job = await h.firstJob();
    await h.executeProgress(job.id);

    h.proxy.pause();
    h.proxy.sever();

    // Grace runs out and the sweep releases the file.
    await until('the sweep to release the file', () => h.job(job.id).ended_at !== null, {
      describe: () => h.describe(),
    });
    const released = h.job(job.id);
    expect(released.lease_state).toBe('expired');
    expect(released.state).toBe('failed');
    expect(released.outcome).toContain('grace window, so this file was released');
    const heldRow = h.files()[0]!;
    expect(heldRow.state).not.toBe('running');
    expect(heldRow.state).not.toBe('good');
    expect(heldRow.attempt_count).toBe(1);
    // Backed off like any stalled attempt, so it is not handed straight back.
    expect(heldRow.hold_until_ms).toBeGreaterThan(Date.now());

    // Meanwhile the node, which cannot know, finished its encode and verify
    // offline and is waiting at Replace's commit gate.
    await until(
      'the offline node to reach Replace',
      () => h.nodeLog(job.id).includes('trawlarr:verifyOutput ---'),
      { describe: () => `${h.nodeLog(job.id)}\n${h.describe()}` },
    );
    expect(sha256Of(original)).toBe(originalHash);

    h.proxy.resume();

    // Back online, it is told the job is gone: the commit is refused and the
    // run stops before writing.
    await until(
      'the node to stop at the commit gate',
      () => h.nodeLog(job.id).includes('The run stopped before a library write'),
      { describe: () => `${h.nodeLog(job.id)}\n${h.describe()}` },
    );
    await until('the node journal to empty', () => h.journalEntries().length === 0, {
      describe: () => h.describe(),
    });
    await until('the node staging directory to empty', () => h.stagingEntries().length === 0, {
      describe: () => JSON.stringify(h.stagingEntries()),
    });

    // THE PROPERTY: the original is byte-for-byte what it was, nothing went
    // to trash, and the file never became good under any identity.
    expect(sha256Of(original)).toBe(originalHash);
    expect(await videoCodecOf(original)).toBe('mpeg4');
    const trash = join(h.lib, '.trawlarr', 'trash');
    expect(existsSync(trash) ? readdirSync(trash) : []).toEqual([]);
    expect(readdirSync(h.lib).filter((name) => !name.startsWith('.'))).toEqual(['a.mkv']);
    const rows = h.files();
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => row.state === 'good')).toEqual([]);
    expect(h.jobs()).toHaveLength(1);
    // The closed row was not rewritten by the late refusal.
    expect(h.job(job.id).state).toBe('failed');
    expect(h.files()[0]!.attempt_count).toBe(1);
  }, 120_000);

  it('applies a report held across a node restart exactly once', async () => {
    const h = await setup({ files: [{ name: 'a.mkv', seconds: 5 }], flow: encodeOnlyFlow });
    const job = await h.firstJob();
    await h.executeProgress(job.id);

    h.proxy.pause();
    h.proxy.sever();

    // The run finishes while the node is disconnected: its report is durable.
    await until('the node to hold its report', () => h.journal(job.id)?.state === 'held-report', {
      describe: () => `${JSON.stringify(h.journal(job.id))}\n${h.describe()}`,
    });
    expect(h.job(job.id).ended_at).toBeNull();

    // Killed, not stopped: nothing in memory survives, only the journal.
    await h.nodeProcess!.stop('SIGKILL');
    expect(h.journal(job.id)?.state).toBe('held-report');

    // The restarted node is refused at least once first, so the report it
    // delivers is read back from disk by a fresh process, not raced in by
    // the old one.
    const refusedBefore = h.proxy.refusedConnections;
    const restarted = h.startNode();
    await until(
      'the restarted node to try to connect',
      () => h.proxy.refusedConnections > refusedBefore,
      { describe: () => restarted.output() },
    );
    h.proxy.resume();

    await until('the held report to be applied', () => h.job(job.id).ended_at !== null, {
      describe: () => `${restarted.output()}\n${h.describe()}`,
    });
    await until('the node journal to empty', () => h.journalEntries().length === 0, {
      describe: () => restarted.output(),
    });
    // Let any duplicate delivery have its chance to do damage.
    await sleep(1_000);

    expect(h.jobs()).toHaveLength(1);
    const ended = h.job(job.id);
    expect(ended.state).toBe('succeeded');
    expect(ended.node_id).toBe(h.nodeId);
    expect(h.files()).toEqual([expect.objectContaining({ state: 'good', attempt_count: 0 })]);
    const finished = h.events.filter(
      (event) => event.type === 'job.finished' && event.jobId === job.id,
    );
    expect(finished).toHaveLength(1);
    // Applied as a result, not as an afterthought on a closed row.
    expect(ended.outcome).not.toContain('late result');
  }, 120_000);

  it('revokes a node mid-job: it is refused on every retry and its lease waits in grace', async () => {
    const h = await setup({ files: [{ name: 'a.mkv', seconds: 5 }], flow: transcodeFlow });
    const original = join(h.lib, 'a.mkv');
    const originalHash = sha256Of(original);
    const job = await h.firstJob();
    await h.executeProgress(job.id);

    await h.daemon.api('POST', `/nodes/${h.nodeId}/revoke`);

    // The node says its credentials were refused, once — not the bare ws
    // "Unexpected server response: 401" that used to spam on every retry.
    await until(
      'the node to log its credentials being refused',
      () => h.nodeProcess!.output().includes("refused this node's credentials"),
      { timeoutMs: 30_000, describe: () => h.nodeProcess!.output() },
    );
    const connectAttemptsBefore = h.proxy.requests.filter((path) =>
      path.startsWith('/api/v1/nodes/connect'),
    ).length;
    // Still retrying underneath the single log line: count raw connect
    // attempts at the proxy, since the node itself only logs the refusal once.
    await until(
      'the node to keep retrying the connection',
      () =>
        h.proxy.requests.filter((path) => path.startsWith('/api/v1/nodes/connect')).length >=
        connectAttemptsBefore + 2,
      { timeoutMs: 30_000, describe: () => h.nodeProcess!.output() },
    );
    expect(h.nodeProcess!.output().split("refused this node's credentials").length - 1).toBe(1);
    expect(h.nodeProcess!.exited()).toBe(false);

    const resource = await h.nodeResource();
    expect(resource.revokedAt).not.toBeNull();
    expect(resource.online).toBe(false);
    const leased = h.job(job.id);
    expect(leased.lease_state).toBe('grace');
    expect(leased.ended_at).toBeNull();

    // A revoked node can still finish its encode, but never install it.
    await until(
      'the revoked node to reach Replace',
      () => h.nodeLog(job.id).includes('trawlarr:verifyOutput ---'),
      { describe: () => h.nodeLog(job.id) },
    );
    await sleep(1_000);
    expect(sha256Of(original)).toBe(originalHash);
    expect(h.files()[0]!.state).toBe('running');
    expect(h.job(job.id).ended_at).toBeNull();
  }, 120_000);

  it('refuses a node that speaks another protocol version, naming both', async () => {
    const h = await setup({
      files: [{ name: 'a.mkv', seconds: 2 }],
      flow: transcodeFlow,
      nodeEnv: { TRAWLARR_PROTOCOL_VERSION_OVERRIDE: String(PROTOCOL_VERSION - 1) },
    });

    await until(
      'the node to log the refusal',
      () => h.nodeProcess!.output().includes('The server refused this node'),
      { describe: () => h.nodeProcess!.output() },
    );
    const output = h.nodeProcess!.output();
    expect(output).toContain(`speaks node protocol version ${String(PROTOCOL_VERSION)}`);
    expect(output).toContain(`this node speaks version ${String(PROTOCOL_VERSION - 1)}`);
    expect(output).not.toContain('Connected to');

    // Enrolled (that is plain HTTP), but never online, and never given work.
    const resource = await h.nodeResource();
    expect(resource.enrolled).toBe(true);
    expect(resource.online).toBe(false);
    await h.daemon.api('PUT', '/workers/counts', { transcode: 0 });
    expect(h.jobs()).toEqual([]);
    expect(h.files()[0]!.state).toBe('queued');
  }, 120_000);

  it('delivers a cancel made while the node is offline, and requeues the file unpenalised', async () => {
    const h = await setup({ files: [{ name: 'a.mkv', seconds: 12 }], flow: transcodeFlow });
    const original = join(h.lib, 'a.mkv');
    const originalHash = sha256Of(original);
    const job = await h.firstJob();
    await h.executeProgress(job.id);

    h.proxy.pause();
    h.proxy.sever();
    await until('the lease to move to grace', () => h.job(job.id).lease_state === 'grace');

    const cancel = await h.daemon.raw('POST', `/jobs/${job.id}/cancel`);
    expect(cancel.status).toBe(202);
    // Durable before the node can hear it.
    expect(h.job(job.id).cancel_requested_at).not.toBeNull();
    expect(h.job(job.id).ended_at).toBeNull();
    // Paused so the requeued file is not immediately claimed again, which
    // would make the ledger row say "running" for a different reason.
    await h.daemon.api('PUT', `/nodes/${h.nodeId}`, { paused: true });

    await sleep(1_000);
    h.proxy.resume();

    await until('the cancelled job to end', () => h.job(job.id).ended_at !== null, {
      describe: () => `${h.nodeLog(job.id)}\n${h.describe()}`,
    });
    const ended = h.job(job.id);
    expect(ended.state).toBe('cancelled');
    // Unpenalised: requeued, no attempt spent, no backoff.
    expect(h.files()).toEqual([
      expect.objectContaining({ state: 'queued', attempt_count: 0, hold_until_ms: null }),
    ]);
    // The node stopped the encode itself — ffmpeg killed by a signal (no exit
    // code), mid-file — and the flow never got past Execute.
    expect(h.nodeLog(job.id)).toContain('ffmpeg failed (code null)');
    expect(h.nodeLog(job.id)).not.toContain('trawlarr:verifyOutput ---');
    expect(sha256Of(original)).toBe(originalHash);
    await until('the node journal to empty', () => h.journalEntries().length === 0, {
      describe: () => h.nodeProcess!.output(),
    });
    await until('the node staging directory to empty', () => h.stagingEntries().length === 0);
  }, 120_000);

  it.runIf(corpusAvailable())(
    'downloads a plugin bundle once and serves the second job from the node cache',
    async () => {
      const h = await setup({
        files: [
          // Different lengths: two byte-identical clips remux to one content
          // identity, which the ledger rightly refuses as a duplicate.
          { name: 'a.mkv', seconds: 1 },
          { name: 'b.mkv', seconds: 2 },
        ],
        flow: communityRemuxFlow,
        pluginSource: true,
      });

      await until(
        'both files to converge on the node',
        async () => {
          if (h.files().length === 2 && h.files().every((row) => row.state === 'good')) return true;
          await h.daemon.api('PUT', '/workers/counts', { transcode: 0 });
          return false;
        },
        { timeoutMs: 90_000, intervalMs: 500, describe: () => h.describe() },
      );

      const jobs = h.jobs();
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.state).toBe('succeeded');
        expect(job.node_id).toBe(h.nodeId);
      }
      for (const name of ['a.mp4', 'b.mp4']) expect(existsSync(join(h.lib, name))).toBe(true);

      // One bundle, cached once on the node, with its verified manifest.
      const cached = readdirSync(join(h.nodeDataDir, 'bundles'));
      const hashes = cached.filter((name) => /^[0-9a-f]{64}$/.test(name));
      expect(hashes).toHaveLength(1);
      const hash = hashes[0]!;
      const manifest = JSON.parse(
        readFileSync(join(h.nodeDataDir, 'bundles', `${hash}.manifest.json`), 'utf8'),
      ) as { files: { relPath: string }[] };
      expect(manifest.files.length).toBeGreaterThan(0);

      // Every bundle-file request the node sent, as the proxy saw it.
      const filePrefix = `/api/v1/nodes/bundles/${hash}/files/`;
      const fileRequests = h.proxy.requests
        .filter((path) => path.startsWith(filePrefix))
        .map((path) => path.slice(filePrefix.length).split('/').map(decodeURIComponent).join('/'));
      // THE PROPERTY: across BOTH jobs, each file in the bundle was fetched
      // exactly once — the second job was served from the node's cache.
      expect(fileRequests.slice().sort()).toEqual(
        manifest.files.map((file) => file.relPath).sort(),
      );
      expect(
        h.proxy.requests.filter((path) => path.startsWith('/api/v1/nodes/bundles/')),
      ).toHaveLength(
        manifest.files.length + 1, // the manifest itself, also once
      );
    },
    180_000,
  );
});
