import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { extractFacts, type FlowDefinition } from '@trawlarr/core';
import type { DocumentPort, StepRecord } from '@trawlarr/engine';
import type { PluginDetails, ProbeData } from '@trawlarr/plugin-api';
import { createEventBus, type TrawlarrEvent } from '../daemon/events.js';
import type { AgentFactoryInput } from '../daemon/supervisor.js';
import { openDatabase, type Db } from '../db/connection.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createJobRepo, type JobRepo } from '../db/job-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo, type MediaFileRepo } from '../db/media-file-repo.js';
import { migrate } from '../db/migrate.js';
import { createNodeRepo, type NodeRepo } from '../db/node-repo.js';
import { createSettingsRepo, type SettingsRepo } from '../db/settings-repo.js';
import { createPluginRepo } from '../plugins/plugin-repo.js';
import { buildJobPayload, type JobPayload } from '../worker/job-payload.js';
import { PROTOCOL_VERSION } from '../worker/protocol.js';
import type { JobReport } from '../worker/run-payload.js';
import { createBundleStore } from './bundles.js';
import { createNodeHub, NODE_SOCKET_PATH, type NodeHub } from './hub.js';
import type { HelloFrame, NodeFrame, ServerFrame } from './node-frames.js';

const NOW = 1_700_000_000_000;
const GRACE_MS = 3_600_000;
const PLUGIN_ID = 'tdarr:setContainer';

const PROBE: ProbeData = {
  streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
  format: { duration: '60.0', size: '4096', bit_rate: '16384' },
};

const waitFor = async (predicate: () => boolean, what = 'condition'): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const noDocuments: DocumentPort = {
  get: () => undefined,
  insert: () => {},
  update: () => {},
  removeOne: () => {},
};

interface NodeClient {
  ws: WebSocket;
  frames: ServerFrame[];
  closed: { code: number; reason: string } | null;
  send(frame: NodeFrame | Record<string, unknown>): void;
  hello(jobs?: HelloFrame['jobs'], over?: Partial<HelloFrame>): Promise<ServerFrame>;
  next<T extends ServerFrame['type']>(
    type: T,
    where?: (frame: Extract<ServerFrame, { type: T }>) => boolean,
  ): Promise<Extract<ServerFrame, { type: T }>>;
}

let db: Db;
let nodes: NodeRepo;
let jobs: JobRepo;
let files: MediaFileRepo;
let settings: SettingsRepo;
let hub: NodeHub;
let server: Server;
let port: number;
let now: number;
let nodesChanged: number;
let events: TrawlarrEvent[];
let creds: { nodeId: string; secret: string };
let logDir: string;
let pluginRoot: string;
let clients: WebSocket[];
let extraHubs: NodeHub[];

const makeHub = (over: { pingIntervalMs?: number; offlineAfterMs?: number } = {}): NodeHub => {
  const bus = createEventBus();
  bus.subscribe((event) => events.push(event));
  return createNodeHub({
    db,
    nodes,
    bundles: createBundleStore(),
    settings,
    bus,
    nowMs: () => now,
    buildVersion: 'test',
    onNodesChanged: () => {
      nodesChanged += 1;
    },
    ...over,
  });
};

beforeEach(async () => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  now = NOW;
  nodesChanged = 0;
  events = [];
  clients = [];
  extraHubs = [];
  nodes = createNodeRepo(db);
  jobs = createJobRepo(db);
  files = createMediaFileRepo(db);
  settings = createSettingsRepo({ db });
  settings.setNodes({ leaseGraceMs: GRACE_MS });
  logDir = mkdtempSync(join(tmpdir(), 'trawlarr-hub-logs-'));

  // An installed plugin whose source tree is a real directory, so `prepare`
  // has a bundle to hash.
  pluginRoot = mkdtempSync(join(tmpdir(), 'trawlarr-hub-plugins-'));
  mkdirSync(join(pluginRoot, 'setContainer'), { recursive: true });
  writeFileSync(join(pluginRoot, 'setContainer', 'index.js'), 'module.exports = {};');
  const plugins = createPluginRepo(db);
  plugins.addSource({ id: 'tdarr', url: pluginRoot, kind: 'local' });
  plugins.replaceSourcePlugins('tdarr', [
    {
      pluginName: 'setContainer',
      relPath: 'setContainer/index.js',
      absPath: join(pluginRoot, 'setContainer', 'index.js'),
      version: '1.0.0',
      details: { name: 'Set Container' } as unknown as PluginDetails,
    },
  ]);

  const { enrollToken, node } = await nodes.create({ name: 'garage', nowMs: NOW });
  const enrolled = await nodes.enroll({ token: enrollToken, nowMs: NOW });
  if (enrolled === null) throw new Error('enroll failed');
  creds = enrolled;
  nodes.update(node.id, { pathMap: [{ serverPath: '/media', nodePath: '/mnt/nas' }] });

  hub = makeHub();
  server = createServer();
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of clients) client.terminate();
  await hub.close();
  for (const extra of extraHubs) await extra.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

/** A claimed, `running` file with a job row, and the payload the supervisor would build. */
const claimJob = (): JobPayload => {
  const flows = createFlowRepo(db);
  const definition: FlowDefinition = {
    nodes: [
      { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
      { id: 'set', pluginId: PLUGIN_ID, pluginVersion: '1.0.0', inputs: {} },
    ],
    edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'set' }],
  };
  const flow = flows.create({ name: `Flow ${String(Math.random())}`, definition, nowMs: now });
  const library = createLibraryRepo(db).create({
    name: `Movies ${String(Math.random())}`,
    roots: [`/media/movies${String(Math.floor(Math.random() * 1e9))}`],
    flowId: flow.id,
    nowMs: now,
  });
  const root = library.roots[0]!;
  const fileId = files.upsertScanned({
    libraryId: library.id,
    identity: {
      inodeKey: `1:${String(Math.random())}`,
      contentKey: `4096:${String(Math.random())}`,
    },
    path: `${root}/a.mkv`,
    nlink: 1,
    sizeBytes: 4096,
    mtimeMs: now,
    ctimeMs: now,
    container: 'mkv',
    nowMs: now,
  });
  files.setProbe({
    fileId,
    probe: PROBE,
    facts: extractFacts({ probe: PROBE, container: 'mkv', sizeBytes: 4096 }),
  });
  files.setState({ fileId, state: 'queued' });
  const claimed = files.claimNext({
    workerClass: 'transcode',
    nowMs: now,
    libraryIds: [library.id],
  });
  if (claimed === null) throw new Error('claim failed');
  const jobId = `job-${String(Math.random()).slice(2)}`;
  const payload = buildJobPayload({
    db,
    claimed,
    jobId,
    dataDir: logDir,
    workerClass: 'transcode',
    hardwareType: 'cpu',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
  });
  jobs.start({
    id: jobId,
    fileId,
    flowId: flow.id,
    flowHash: flow.definitionHash,
    nowMs: now,
    logPath: payload.logPath,
  });
  return payload;
};

interface Sinks {
  steps: StepRecord[];
  logs: string[];
  heartbeats: number[];
}

const factoryInput = (sinks: Sinks): AgentFactoryInput => ({
  id: 'worker-1',
  documents: noDocuments,
  onStep: (step) => sinks.steps.push(step),
  onHeartbeat: (at) => sinks.heartbeats.push(at),
  onProgress: () => {},
  onLog: (text) => sinks.logs.push(text),
  nowMs: () => now,
});

const connectNode = async (
  headers: Record<string, string> = {
    'x-trawlarr-node': creds.nodeId,
    authorization: `Bearer ${creds.secret}`,
  },
  options: { autoPong?: boolean } = {},
): Promise<NodeClient> =>
  await new Promise<NodeClient>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${NODE_SOCKET_PATH}`, {
      headers,
      autoPong: options.autoPong ?? true,
    });
    clients.push(ws);
    const client: NodeClient = {
      ws,
      frames: [],
      closed: null,
      send: (frame) => {
        ws.send(JSON.stringify(frame));
      },
      hello: async (journal = [], over = {}) => {
        client.send({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          buildVersion: 'node-test',
          hardwareTypes: ['cpu'],
          hardwareCaps: {},
          ffmpegPath: '/usr/bin/ffmpeg',
          ffprobePath: '/usr/bin/ffprobe',
          jobs: journal,
          ...over,
        });
        await waitFor(
          () => client.frames.some((f) => f.type === 'welcome' || f.type === 'refused'),
          'welcome or refused',
        );
        return client.frames.find((f) => f.type === 'welcome' || f.type === 'refused')!;
      },
      next: async (type, where) => {
        let found: ServerFrame | undefined;
        await waitFor(() => {
          found = client.frames.find(
            (frame) => frame.type === type && (where === undefined || where(frame as never)),
          );
          return found !== undefined;
        }, `a ${type} frame`);
        return found as never;
      },
    };
    ws.on('message', (data: Buffer) => {
      client.frames.push(JSON.parse(String(data)) as ServerFrame);
    });
    ws.on('close', (code, reason) => {
      client.closed = { code, reason: String(reason) };
    });
    ws.on('open', () => resolve(client));
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`handshake refused with ${String(res.statusCode)}`));
    });
    ws.on('error', reject);
  });

/** Online node with one running job the hub has sent it. */
const startRemoteJob = async () => {
  const client = await connectNode();
  await client.hello();
  const payload = claimJob();
  const sinks: Sinks = { steps: [], logs: [], heartbeats: [] };
  const agent = hub.createAgent({ ...factoryInput(sinks), nodeId: creds.nodeId });
  const run = agent.run(payload);
  const outcome: { settled: boolean; error: unknown; report: JobReport | null } = {
    settled: false,
    error: null,
    report: null,
  };
  run.then(
    (report) => {
      outcome.settled = true;
      outcome.report = report;
    },
    (error: unknown) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  const jobFrame = await client.next('job');
  return { client, payload, agent, run, outcome, jobFrame, sinks };
};

const leaseOf = (jobId: string) => {
  const row = jobs.getById(jobId)!;
  return { state: row.leaseState, expiresAtMs: row.leaseExpiresAt };
};

describe('createNodeHub', () => {
  it('refuses an upgrade with no or bad credentials with a 401, before any socket opens', async () => {
    await expect(connectNode({})).rejects.toThrow(/401/);
    await expect(
      connectNode({ 'x-trawlarr-node': creds.nodeId, authorization: 'Bearer not-the-secret' }),
    ).rejects.toThrow(/401/);
    expect(hub.isOnline(creds.nodeId)).toBe(false);
  });

  it('refuses a mismatched protocol version naming both, then closes 4002', async () => {
    const client = await connectNode();
    const refused = await client.hello([], { protocolVersion: 99 });
    expect(refused.type).toBe('refused');
    const reason = (refused as Extract<ServerFrame, { type: 'refused' }>).reason;
    expect(reason).toContain(String(PROTOCOL_VERSION));
    expect(reason).toContain('99');
    expect((refused as Extract<ServerFrame, { type: 'refused' }>).retryAfterMs).toBe(300_000);
    await waitFor(() => client.closed !== null, 'close');
    expect(client.closed?.code).toBe(4002);
    expect(hub.isOnline(creds.nodeId)).toBe(false);
  });

  it('closes 4001 when the first frame is not hello', async () => {
    const client = await connectNode();
    client.send({ type: 'libraries', libraries: [] });
    await waitFor(() => client.closed !== null, 'close');
    expect(client.closed?.code).toBe(4001);
  });

  it('welcomes a valid hello with the path map and mapped library roots, and goes online', async () => {
    createLibraryRepo(db).create({ name: 'Movies', roots: ['/media/movies'], nowMs: now });
    createLibraryRepo(db).create({ name: 'Elsewhere', roots: ['/srv/tv'], nowMs: now });
    const client = await connectNode();
    const welcome = (await client.hello()) as Extract<ServerFrame, { type: 'welcome' }>;

    expect(welcome.type).toBe('welcome');
    expect(welcome.config.pathMap).toEqual([{ serverPath: '/media', nodePath: '/mnt/nas' }]);
    const roots = Object.fromEntries(
      welcome.config.libraries.map((library) => [library.name, library.nodeRoots]),
    );
    expect(roots).toEqual({ Movies: ['/mnt/nas/movies'], Elsewhere: [null] });
    expect(hub.isOnline(creds.nodeId)).toBe(true);
    expect(nodesChanged).toBeGreaterThan(0);
    expect(nodes.getById(creds.nodeId)?.buildVersion).toBe('node-test');
    expect(events).toContainEqual({ type: 'nodes.changed', nodeId: creds.nodeId, online: true });
  });

  it('records library probes and reports them through onlineNodes', async () => {
    const client = await connectNode();
    await client.hello();
    const before = nodesChanged;
    client.send({
      type: 'libraries',
      libraries: [
        { libraryId: 'lib-a', reachable: true, detail: 'ok' },
        { libraryId: 'lib-b', reachable: false, detail: 'missing' },
      ],
    });
    await waitFor(() => nodesChanged > before, 'onNodesChanged');
    const [online] = hub.onlineNodes();
    expect(online?.nodeId).toBe(creds.nodeId);
    expect([...online!.reachableLibraryIds]).toEqual(['lib-a']);
  });

  it('sends a mapped job with bundles, and records a connected lease and the server-view payload', async () => {
    const { jobFrame, payload } = await startRemoteJob();
    expect(jobFrame.payload.path).toBe(payload.path.replace('/media', '/mnt/nas'));
    expect(Object.keys(jobFrame.payload.pluginBundles)).toEqual([PLUGIN_ID]);
    expect(jobFrame.payload.pluginBundles[PLUGIN_ID]?.relPath).toBe('setContainer/index.js');
    expect(leaseOf(payload.jobId)).toEqual({ state: 'connected', expiresAtMs: null });
    const leased = jobs.listLeased().find((row) => row.jobId === payload.jobId)!;
    expect((JSON.parse(leased.payloadJson) as JobPayload).path).toBe(payload.path);
  });

  it('appends log frames and a backfill to the server job log', async () => {
    const { client, payload, sinks } = await startRemoteJob();
    client.send({
      type: 'agent',
      jobId: payload.jobId,
      message: { type: 'log', text: 'line one' },
    });
    client.send({
      type: 'log-backfill',
      jobId: payload.jobId,
      fromLine: 1,
      lines: ['line two', 'line three'],
    });
    await waitFor(() => {
      try {
        return readFileSync(payload.logPath!, 'utf8').includes('line three');
      } catch {
        return false;
      }
    }, 'the log file');
    expect(readFileSync(payload.logPath!, 'utf8')).toBe(
      'line one\n[backfill] line two\nline three\n',
    );
    expect(sinks.logs).toEqual(['line one']);
  });

  it('grants a replace commit while connected and returns the lease to connected after the next step', async () => {
    const { client, payload } = await startRemoteJob();
    client.send({
      type: 'agent',
      jobId: payload.jobId,
      message: { type: 'commit-request', id: 1, kind: 'replace', pluginId: 'trawlarr:replace' },
    });
    const result = await client.next('agent', (f) => f.message.type === 'commit-result');
    expect(result.message).toEqual({ type: 'commit-result', id: 1, granted: true, reason: null });
    expect(leaseOf(payload.jobId).state).toBe('committing');

    client.send({
      type: 'agent',
      jobId: payload.jobId,
      message: {
        type: 'step',
        step: {
          seq: 1,
          nodeId: 'set',
          pluginId: PLUGIN_ID,
          pluginName: 'x',
          outputNumber: 1,
          outputOutcome: null,
          durationMs: 1,
          logExcerpt: '',
          error: null,
        },
      },
    });
    await waitFor(() => leaseOf(payload.jobId).state === 'connected', 'lease back to connected');
  });

  it('moves a leased job to grace on close, then releases it on sweep once grace passes', async () => {
    const { client, payload, outcome } = await startRemoteJob();
    now += 1_000;
    client.ws.close();
    await waitFor(() => leaseOf(payload.jobId).state === 'grace', 'grace');
    expect(leaseOf(payload.jobId)).toEqual({ state: 'grace', expiresAtMs: now + GRACE_MS });
    expect(hub.isOnline(creds.nodeId)).toBe(false);
    expect(events).toContainEqual({ type: 'nodes.changed', nodeId: creds.nodeId, online: false });

    now += GRACE_MS - 1;
    hub.sweepLeases();
    expect(leaseOf(payload.jobId).state).toBe('grace');

    now += 1;
    hub.sweepLeases();
    await waitFor(() => outcome.settled, 'run to settle');
    expect(String((outcome.error as Error).message)).toBe(
      'Node garage was offline for longer than the 60-minute grace window, so this file was released.',
    );
    expect(leaseOf(payload.jobId).state).toBe('expired');
  });

  it('continues a running job that reconnects inside grace, and flushes a queued cancel', async () => {
    const { client, payload, agent, outcome } = await startRemoteJob();
    client.ws.close();
    await waitFor(() => leaseOf(payload.jobId).state === 'grace', 'grace');
    agent.cancel();

    now += GRACE_MS / 2;
    const again = await connectNode();
    const welcome = (await again.hello([
      { jobId: payload.jobId, state: 'running', logLineCount: 0 },
    ])) as Extract<ServerFrame, { type: 'welcome' }>;
    expect(welcome.jobs).toEqual([{ jobId: payload.jobId, action: 'continue', logLinesHave: 0 }]);
    expect(leaseOf(payload.jobId)).toEqual({ state: 'connected', expiresAtMs: null });
    const cancel = await again.next('agent', (f) => f.message.type === 'cancel');
    expect(cancel.jobId).toBe(payload.jobId);
    expect(outcome.settled).toBe(false);

    // Cancelled: never granted a commit, whatever the lease says.
    again.send({
      type: 'agent',
      jobId: payload.jobId,
      message: { type: 'commit-request', id: 9, kind: 'replace', pluginId: 'x' },
    });
    const refused = await again.next('agent', (f) => f.message.type === 'commit-result');
    expect(refused.message).toMatchObject({ granted: false });
  });

  it('abandons a running job that reconnects after its grace expired, and refuses its commit', async () => {
    const { client, payload, outcome } = await startRemoteJob();
    client.ws.close();
    await waitFor(() => leaseOf(payload.jobId).state === 'grace', 'grace');

    now += GRACE_MS + 1;
    const again = await connectNode();
    const welcome = (await again.hello([
      { jobId: payload.jobId, state: 'running', logLineCount: 0 },
    ])) as Extract<ServerFrame, { type: 'welcome' }>;
    expect(welcome.jobs).toEqual([{ jobId: payload.jobId, action: 'abandon', logLinesHave: 0 }]);
    await waitFor(() => outcome.settled, 'run to settle');
    expect(outcome.error).toMatchObject({ reported: false });
    expect(leaseOf(payload.jobId).state).toBe('expired');

    again.send({
      type: 'agent',
      jobId: payload.jobId,
      message: { type: 'commit-request', id: 4, kind: 'replace', pluginId: 'x' },
    });
    const refused = await again.next('agent', (f) => f.message.type === 'commit-result');
    expect(refused.message).toMatchObject({ type: 'commit-result', id: 4, granted: false });
  });

  it('treats a node restart as lost, including a leased job its journal does not mention', async () => {
    const first = await startRemoteJob();
    const payloadB = claimJob();
    const agentB = hub.createAgent({
      ...factoryInput({ steps: [], logs: [], heartbeats: [] }),
      nodeId: creds.nodeId,
    });
    let bError: unknown = null;
    agentB.run(payloadB).catch((error: unknown) => {
      bError = error;
    });
    await first.client.next('job', (f) => f.jobId === payloadB.jobId);
    first.client.ws.close();
    await waitFor(() => leaseOf(payloadB.jobId).state === 'grace', 'grace');

    const again = await connectNode();
    const welcome = (await again.hello([
      { jobId: first.payload.jobId, state: 'lost', logLineCount: 0 },
    ])) as Extract<ServerFrame, { type: 'welcome' }>;
    expect(welcome.jobs).toEqual([{ jobId: first.payload.jobId, action: 'lost', logLinesHave: 0 }]);
    await waitFor(() => first.outcome.settled && bError !== null, 'both runs to settle');
    expect((first.outcome.error as Error).message).toBe(
      'Node garage restarted while running this job.',
    );
    expect((bError as Error).message).toBe('Node garage restarted while running this job.');
  });

  it('replaces an older connection for the same node with close 4000, without moving its leases', async () => {
    const { client, payload } = await startRemoteJob();
    const second = await connectNode();
    await waitFor(() => client.closed !== null, 'old socket to close');
    expect(client.closed?.code).toBe(4000);
    expect(leaseOf(payload.jobId).state).toBe('connected');
    await second.hello([{ jobId: payload.jobId, state: 'running', logLineCount: 0 }]);
    expect(hub.isOnline(creds.nodeId)).toBe(true);
  });

  it('terminates a node that stops answering pings', async () => {
    await hub.close();
    hub = makeHub({ pingIntervalMs: 10, offlineAfterMs: 45_000 });
    hub.attach(server);
    const client = await connectNode(undefined, { autoPong: false });
    await client.hello();
    now += 45_001;
    await waitFor(() => client.closed !== null, 'the silent node to be dropped');
    await waitFor(() => !hub.isOnline(creds.nodeId), 'offline');
  });

  it('adopts every leased job after a restart, with grace counted from the new start', async () => {
    const { payload } = await startRemoteJob();
    // "Restart": a second hub over the same database, a long time later.
    now += 10 * GRACE_MS;
    const restarted = makeHub();
    extraHubs.push(restarted);
    const adopted = restarted.adoptLeasedJobs(() =>
      factoryInput({ steps: [], logs: [], heartbeats: [] }),
    );
    expect(adopted.map((job) => job.payload.jobId)).toEqual([payload.jobId]);
    expect(adopted[0]?.nodeId).toBe(creds.nodeId);
    expect(leaseOf(payload.jobId)).toEqual({ state: 'grace', expiresAtMs: now + GRACE_MS });
  });

  it('appends a late result for a job already released, without touching the ledger, and acks it', async () => {
    const { client, payload, outcome } = await startRemoteJob();
    client.ws.close();
    await waitFor(() => leaseOf(payload.jobId).state === 'grace', 'grace');
    now += GRACE_MS;
    hub.sweepLeases();
    await waitFor(() => outcome.settled, 'release');
    // What the supervisor's settlement would do with the rejection.
    jobs.finish({ jobId: payload.jobId, state: 'failed', outcome: 'released', nowMs: now });
    const fileBefore = files.getById(payload.fileId);

    const again = await connectNode();
    const welcome = (await again.hello([
      { jobId: payload.jobId, state: 'held-report', logLineCount: 0 },
    ])) as Extract<ServerFrame, { type: 'welcome' }>;
    expect(welcome.jobs).toEqual([
      { jobId: payload.jobId, action: 'apply-report', logLinesHave: 0 },
    ]);

    again.send({
      type: 'agent',
      jobId: payload.jobId,
      message: {
        type: 'done',
        report: { jobId: payload.jobId, outcome: 'Transcoded to hevc', replaced: null },
      },
    });
    await again.next('ack-report', (f) => f.jobId === payload.jobId);
    expect(files.getById(payload.fileId)).toEqual(fileBefore);
    expect(jobs.getById(payload.jobId)?.outcome).toBe(
      'released\nA late result arrived from node garage after this job was released: Transcoded to hevc',
    );
  });

  it('applies a held report for a still-claimed job through the handle', async () => {
    const { client, payload, outcome } = await startRemoteJob();
    client.ws.close();
    await waitFor(() => leaseOf(payload.jobId).state === 'grace', 'grace');

    const again = await connectNode();
    const welcome = (await again.hello([
      { jobId: payload.jobId, state: 'held-report', logLineCount: 0 },
    ])) as Extract<ServerFrame, { type: 'welcome' }>;
    expect(welcome.jobs[0]?.action).toBe('apply-report');
    again.send({
      type: 'agent',
      jobId: payload.jobId,
      message: {
        type: 'done',
        report: {
          jobId: payload.jobId,
          outcome: 'ok',
          replaced: { path: payload.path.replace('/media', '/mnt/nas') },
        },
      },
    });
    await waitFor(() => outcome.settled, 'report applied');
    expect(outcome.report?.replaced?.path).toBe(payload.path);
  });
});
