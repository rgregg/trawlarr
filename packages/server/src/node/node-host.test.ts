import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createBundleStore } from '../nodes/bundles.js';
import {
  MAX_FRAME_BYTES,
  type NodeConfigFrame,
  type NodeFrame,
  type ServerFrame,
} from '../nodes/node-frames.js';
import { MAX_LOG_EXCERPT_CHARS } from '../job-log/log-excerpt.js';
import { AgentFailure, type AgentHandle, type AgentHandleDeps } from '../worker/agent-handle.js';
import type { JobPayload } from '../worker/job-payload.js';
import { PROTOCOL_VERSION } from '../worker/protocol.js';
import type { JobReport } from '../worker/run-payload.js';
import { createJournal } from './journal.js';
import {
  bundleCacheMaxBytesFrom,
  DEFAULT_BUNDLE_CACHE_MAX_BYTES,
  startNodeHost,
  type NodeHost,
  type NodeHostInput,
} from './node-host.js';

// ---------------------------------------------------------------------------
// A fake server: the enroll and bundle endpoints over plain `http`, and the
// node socket over a real `ws` WebSocketServer — the same library the hub
// uses — on port 0.
// ---------------------------------------------------------------------------

interface FakeConnection {
  ws: WebSocket;
  headers: IncomingMessage['headers'];
  frames: NodeFrame[];
  closed: boolean;
  send(frame: ServerFrame): void;
  next<T extends NodeFrame['type']>(
    type: T,
    predicate?: (frame: Extract<NodeFrame, { type: T }>) => boolean,
  ): Promise<Extract<NodeFrame, { type: T }>>;
}

interface FakeServer {
  url: string;
  connections: FakeConnection[];
  connectionTimes: number[];
  enrollTokens: string[];
  bundleRequests: string[];
  nextConnection(): Promise<FakeConnection>;
  bundle: { hash: string; relPath: string };
  close(): Promise<void>;
}

const NODE_ID = 'node-1';
const SECRET = 'the-node-secret';
const GOOD_TOKEN = 'good-token';

const waitFor = async (check: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const startFakeServer = async (): Promise<FakeServer> => {
  const source = mkdtempSync(join(tmpdir(), 'trawlarr-node-host-src-'));
  mkdirSync(join(source, 'FlowHelpers'), { recursive: true });
  mkdirSync(join(source, 'plugins', 'demo'), { recursive: true });
  writeFileSync(join(source, 'FlowHelpers', 'lib.js'), 'module.exports = 1;\n');
  writeFileSync(join(source, 'plugins', 'demo', 'index.js'), 'module.exports = {};\n');
  const store = createBundleStore();
  const { hash } = await store.manifestFor(source);

  const connections: FakeConnection[] = [];
  const connectionTimes: number[] = [];
  const enrollTokens: string[] = [];
  const bundleRequests: string[] = [];
  const waiters: ((conn: FakeConnection) => void)[] = [];

  const authorised = (req: IncomingMessage): boolean =>
    req.headers['x-trawlarr-node'] === NODE_ID && req.headers.authorization === `Bearer ${SECRET}`;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/v1/nodes/enroll') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const token = (JSON.parse(body) as { token: string }).token;
        enrollTokens.push(token);
        if (token !== GOOD_TOKEN) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'enrollment_refused', message: 'no' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ nodeId: NODE_ID, secret: SECRET }));
      });
      return;
    }
    const prefix = '/api/v1/nodes/bundles/';
    if (req.method === 'GET' && url.pathname.startsWith(prefix)) {
      if (!authorised(req)) {
        res.writeHead(401);
        res.end();
        return;
      }
      bundleRequests.push(url.pathname);
      const rest = url.pathname.slice(prefix.length);
      const at = rest.indexOf('/files/');
      if (at === -1) {
        void store.manifestFor(source).then(({ manifest }) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(manifest));
        });
        return;
      }
      const relPath = rest
        .slice(at + '/files/'.length)
        .split('/')
        .map(decodeURIComponent)
        .join('/');
      const path = store.filePath(decodeURIComponent(rest.slice(0, at)), relPath);
      if (path === null) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(readFileSync(path));
      return;
    }
    res.writeHead(404);
    res.end();
  };

  const server: Server = createServer(handler);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/v1/nodes/connect') {
      socket.destroy();
      return;
    }
    if (!authorised(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const frames: NodeFrame[] = [];
      const frameWaiters: {
        match: (frame: NodeFrame) => boolean;
        resolve: (f: NodeFrame) => void;
      }[] = [];
      const conn: FakeConnection = {
        ws,
        headers: req.headers,
        frames,
        closed: false,
        send: (frame) => ws.send(JSON.stringify(frame)),
        next: (type, predicate) => {
          const match = (frame: NodeFrame): boolean =>
            frame.type === type &&
            (predicate === undefined ||
              predicate(frame as Extract<NodeFrame, { type: typeof type }>));
          const seen = frames.find(match);
          if (seen !== undefined) return Promise.resolve(seen as never);
          return new Promise((resolve) => {
            frameWaiters.push({ match, resolve: resolve as (f: NodeFrame) => void });
          });
        },
      };
      ws.on('message', (data) => {
        const frame = JSON.parse(String(data)) as NodeFrame;
        frames.push(frame);
        for (const waiter of [...frameWaiters]) {
          if (waiter.match(frame)) {
            frameWaiters.splice(frameWaiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
      });
      ws.on('close', () => {
        conn.closed = true;
      });
      connections.push(conn);
      connectionTimes.push(Date.now());
      const waiter = waiters.shift();
      waiter?.(conn);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    connections,
    connectionTimes,
    enrollTokens,
    bundleRequests,
    bundle: { hash, relPath: 'plugins/demo' },
    nextConnection: () => new Promise((resolve) => waiters.push(resolve)),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

// ---------------------------------------------------------------------------
// A fake agent: records what it was built with and run on, and settles only
// when the test says so.
// ---------------------------------------------------------------------------

interface FakeAgent {
  deps: AgentHandleDeps & { id: string };
  payload: JobPayload | null;
  cancels: number;
  kills: number;
  resolve(report: JobReport): void;
  reject(error: AgentFailure): void;
}

const fakeAgentFactory = () => {
  const agents: FakeAgent[] = [];
  const createAgent = ((deps: AgentHandleDeps & { id: string }): AgentHandle => {
    let resolveRun: (report: JobReport) => void = () => {};
    let rejectRun: (error: AgentFailure) => void = () => {};
    let resolveExited: (code: number | null) => void = () => {};
    const agent: FakeAgent = {
      deps,
      payload: null,
      cancels: 0,
      kills: 0,
      resolve: (report) => {
        resolveRun(report);
        resolveExited(0);
      },
      reject: (error) => {
        rejectRun(error);
        resolveExited(1);
      },
    };
    agents.push(agent);
    return {
      id: deps.id,
      pid: undefined,
      exited: new Promise((resolve) => {
        resolveExited = resolve;
      }),
      run: (payload) => {
        agent.payload = payload;
        return new Promise<JobReport>((resolve, reject) => {
          resolveRun = resolve;
          rejectRun = reject;
        });
      },
      cancel: () => {
        agent.cancels += 1;
      },
      kill: () => {
        agent.kills += 1;
        // What a SIGKILLed group looks like to the handle: an exit with no report.
        agent.reject(
          new AgentFailure(`Worker ${deps.id} exited on SIGKILL`, { signal: 'SIGKILL' }),
        );
      },
    };
  }) as unknown as NonNullable<NodeHostInput['createAgent']>;
  return { agents, createAgent };
};

const config = (libraries: NodeConfigFrame['libraries'] = []): NodeConfigFrame => ({
  type: 'config',
  nodeId: NODE_ID,
  schedule: { timezone: 'UTC', baseCounts: { transcode: 1, health: 1 }, windows: [] },
  paused: false,
  pathMap: [],
  libraries,
});

const payloadFor = (jobId: string, bundle: { hash: string; relPath: string }): JobPayload =>
  ({
    jobId,
    fileId: 'file-1',
    libraryId: 'lib-1',
    path: '/mnt/media/a.mkv',
    ffmpegPath: '/server/ffmpeg',
    ffprobePath: '/server/ffprobe',
    logPath: '/server/data/logs/jobs/x.log',
    pluginPaths: { 'demo:plugin': '/server/plugins/demo' },
    pluginBundles: { 'demo:plugin': { bundle: bundle.hash, relPath: bundle.relPath } },
  }) as unknown as JobPayload;

const reportFor = (jobId: string): JobReport =>
  ({
    jobId,
    fileId: 'file-1',
    steps: [],
    stopReason: 'end',
    failed: false,
    error: null,
    success: true,
    outcome: 'converged',
    replaced: null,
    preFacts: {},
    postFacts: null,
    cancelled: false,
  }) as unknown as JobReport;

// ---------------------------------------------------------------------------

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const newDataDir = (): string => mkdtempSync(join(tmpdir(), 'trawlarr-node-host-'));

const setup = async (overrides: Partial<NodeHostInput> = {}) => {
  const server = await startFakeServer();
  cleanups.push(() => server.close());
  const factory = fakeAgentFactory();
  const dataDir = overrides.dataDir ?? newDataDir();
  const base: NodeHostInput = {
    dataDir,
    serverUrl: server.url,
    enrollToken: GOOD_TOKEN,
    ffmpegPath: '/node/ffmpeg',
    ffprobePath: '/node/ffprobe',
    hardware: { available: ['cpu'], caps: {} },
    createAgent: factory.createAgent,
    reconnectDelaysMs: [10],
    libraryProbeIntervalMs: 60_000,
    log: () => {},
  };
  const start = async (extra: Partial<NodeHostInput> = {}): Promise<NodeHost> => {
    const host = await startNodeHost({ ...base, ...overrides, ...extra });
    let stopped = false;
    cleanups.push(async () => {
      if (stopped) return;
      // A fake agent settles only when told to; a real one's cancel ladder
      // ends its run, which is what `stop()` waits for.
      for (const agent of factory.agents) {
        agent.reject(new AgentFailure('stopped by the test', { cancelled: true }));
      }
      await host.stop();
    });
    const originalStop = host.stop.bind(host);
    host.stop = async () => {
      stopped = true;
      await originalStop();
    };
    return host;
  };
  return { server, factory, dataDir, start };
};

/** Accept the next connection: wait for its hello and answer with a welcome. */
const welcome = async (
  server: FakeServer,
  jobs: Extract<ServerFrame, { type: 'welcome' }>['jobs'] = [],
  libraries: NodeConfigFrame['libraries'] = [],
) => {
  const conn = server.connections.at(-1) ?? (await server.nextConnection());
  const hello = await conn.next('hello');
  conn.send({ type: 'welcome', config: config(libraries), jobs });
  return { conn, hello };
};

describe('startNodeHost', () => {
  it('enrolls on first run, writes node.json, and says hello with an empty journal', async () => {
    const { server, dataDir, start } = await setup();
    const connecting = server.nextConnection();
    const host = await start();
    const conn = await connecting;
    const hello = await conn.next('hello');

    expect(server.enrollTokens).toEqual([GOOD_TOKEN]);
    const state = JSON.parse(readFileSync(join(dataDir, 'node.json'), 'utf8')) as {
      nodeId: string;
      secret: string;
    };
    expect(state).toMatchObject({ nodeId: NODE_ID, secret: SECRET, serverUrl: server.url });
    expect(conn.headers['x-trawlarr-node']).toBe(NODE_ID);
    expect(conn.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(hello).toMatchObject({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      hardwareTypes: ['cpu'],
      ffmpegPath: '/node/ffmpeg',
      ffprobePath: '/node/ffprobe',
      jobs: [],
    });

    conn.send({ type: 'welcome', config: config(), jobs: [] });
    await host.started;
    expect(host.status()).toMatchObject({ connected: true, nodeId: NODE_ID, running: [] });
  });

  it('rejects `started` with the fixed message when the enrollment token is refused', async () => {
    const { start } = await setup({ enrollToken: 'wrong' });
    const host = await start();
    await expect(host.started).rejects.toThrow(
      "The enrollment token was refused: it is wrong, expired, or already used. Create a new one on the server's Nodes page.",
    );
  });

  it('runs a job through the agent with cached plugin bundles and node-local paths', async () => {
    const { server, factory, dataDir, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;

    conn.send({ type: 'job', jobId: 'job-1', payload: payloadFor('job-1', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);
    const agent = factory.agents[0]!;

    const root = join(dataDir, 'bundles', server.bundle.hash);
    expect(agent.deps.id).toBe('job-1');
    expect(agent.payload!.pluginPaths).toEqual({ 'demo:plugin': join(root, 'plugins/demo') });
    expect(existsSync(join(root, 'FlowHelpers', 'lib.js'))).toBe(true);
    expect(agent.payload!.logPath).toBe(join(dataDir, 'logs', 'jobs', 'job-1.log'));
    expect(agent.payload!.ffmpegPath).toBe('/node/ffmpeg');
    expect(agent.payload!.ffprobePath).toBe('/node/ffprobe');
    expect(host.status().running).toEqual(['job-1']);

    // Liveness frames relay inside `agent` envelopes.
    agent.deps.onProgress({ percent: 50, stage: 'encoding' });
    agent.deps.onLog('a log line');
    await conn.next('agent', (f) => f.message.type === 'progress');
    await conn.next('agent', (f) => f.message.type === 'log');

    // A duplicate job frame for a running job is not run twice.
    conn.send({ type: 'job', jobId: 'job-1', payload: payloadFor('job-1', server.bundle) });
    agent.resolve(reportFor('job-1'));
    const done = await conn.next('agent', (f) => f.message.type === 'done');
    expect(done.jobId).toBe('job-1');
    expect(factory.agents).toHaveLength(1);
  });

  it('caps step log excerpts in step and done frames, so a chatty plugin cannot exceed the frame limit', async () => {
    // The hub's socket refuses a frame over MAX_FRAME_BYTES with 1009; the
    // node reconnects and re-sends the same held report, for ever.
    const { server, factory, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;

    conn.send({ type: 'job', jobId: 'job-big', payload: payloadFor('job-big', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);
    const agent = factory.agents[0]!;
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 1024);
    const step = {
      seq: 1,
      nodeId: 'n',
      pluginId: 'p',
      pluginName: 'P',
      outputNumber: 1,
      outputOutcome: null,
      durationMs: 1,
      logExcerpt: huge,
      error: null,
    };

    agent.deps.onStep(step);
    const stepFrame = await conn.next('agent', (f) => f.message.type === 'step');
    const sentStep = (stepFrame.message as { step: { logExcerpt: string } }).step;
    expect(sentStep.logExcerpt.length).toBeLessThan(MAX_LOG_EXCERPT_CHARS + 200);

    agent.resolve({ ...reportFor('job-big'), steps: [step, { ...step, seq: 2 }] });
    const done = await conn.next('agent', (f) => f.message.type === 'done');
    expect(Buffer.byteLength(JSON.stringify(done), 'utf8')).toBeLessThan(MAX_FRAME_BYTES);
    const report = (done.message as { report: JobReport }).report;
    for (const sent of report.steps) {
      expect(sent.logExcerpt.length).toBeLessThan(MAX_LOG_EXCERPT_CHARS + 200);
      expect(sent.logExcerpt.startsWith('xxx')).toBe(true);
    }
  });

  it('prunes the bundle cache to the configured cap once a job settles', async () => {
    const pruned: number[] = [];
    const { server, factory, start } = await setup({
      bundleCacheMaxBytes: 12_345,
      onBundleCachePrune: (maxBytes) => {
        pruned.push(maxBytes);
      },
    });
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;

    conn.send({ type: 'job', jobId: 'job-p', payload: payloadFor('job-p', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);
    expect(pruned).toEqual([]);
    factory.agents[0]!.resolve(reportFor('job-p'));
    await conn.next('agent', (f) => f.message.type === 'done');
    await waitFor(() => pruned.length > 0);
    expect(pruned).toEqual([12_345]);
  });

  it('reads the bundle cache cap from TRAWLARR_NODE_BUNDLE_CACHE_BYTES, defaulting to 2 GiB', () => {
    expect(DEFAULT_BUNDLE_CACHE_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(bundleCacheMaxBytesFrom({})).toBe(DEFAULT_BUNDLE_CACHE_MAX_BYTES);
    expect(bundleCacheMaxBytesFrom({ TRAWLARR_NODE_BUNDLE_CACHE_BYTES: '5000' })).toBe(5000);
    expect(bundleCacheMaxBytesFrom({ TRAWLARR_NODE_BUNDLE_CACHE_BYTES: 'lots' })).toBe(
      DEFAULT_BUNDLE_CACHE_MAX_BYTES,
    );
  });

  it('holds a failed report naming the plugin and bundle when the bundle cannot be fetched', async () => {
    const { server, factory, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;

    const missing = { hash: 'f'.repeat(64), relPath: 'plugins/demo' };
    conn.send({ type: 'job', jobId: 'job-2', payload: payloadFor('job-2', missing) });
    const failed = await conn.next('agent', (f) => f.message.type === 'failed');
    const message = failed.message as Extract<NodeFrame, { type: 'agent' }>['message'] & {
      type: 'failed';
    };
    expect(message.error).toContain('demo:plugin');
    expect(message.error).toContain(missing.hash);
    expect(factory.agents).toHaveLength(0);
  });

  it('journals the report before sending it, and re-offers it after a restart until acked', async () => {
    const { server, factory, dataDir, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;

    conn.send({ type: 'job', jobId: 'job-3', payload: payloadFor('job-3', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);

    // The socket dies before the report can go out.
    conn.ws.terminate();
    await waitFor(() => !host.status().connected);
    factory.agents[0]!.resolve(reportFor('job-3'));
    await waitFor(() => existsSync(join(dataDir, 'journal', 'job-3.json')));
    await waitFor(
      () =>
        (
          JSON.parse(readFileSync(join(dataDir, 'journal', 'job-3.json'), 'utf8')) as {
            state: string;
          }
        ).state === 'held-report',
    );
    await host.stop();

    const next = server.nextConnection();
    const restarted = await start({ enrollToken: undefined });
    const conn2 = await next;
    const hello = await conn2.next('hello');
    expect(hello.jobs).toEqual([{ jobId: 'job-3', state: 'held-report', logLineCount: 0 }]);

    conn2.send({
      type: 'welcome',
      config: config(),
      jobs: [{ jobId: 'job-3', action: 'apply-report', logLinesHave: 0 }],
    });
    const resent = await conn2.next('agent', (f) => f.message.type === 'done');
    expect(resent.jobId).toBe('job-3');
    expect(existsSync(join(dataDir, 'journal', 'job-3.json'))).toBe(true);

    conn2.send({ type: 'ack-report', jobId: 'job-3' });
    await waitFor(() => !existsSync(join(dataDir, 'journal', 'job-3.json')));
    await restarted.started;
  });

  it('keeps a commit request pending across a disconnect, granting only on the server answer', async () => {
    const { server, factory, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;

    conn.send({ type: 'job', jobId: 'job-4', payload: payloadFor('job-4', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);
    const agent = factory.agents[0]!;

    conn.ws.terminate();
    await waitFor(() => !host.status().connected);

    let answer: { granted: boolean; reason: string | null } | null = null;
    void agent.deps.commits!({ kind: 'replace', pluginId: 'trawlarr:replaceOriginal' }).then(
      (result) => {
        answer = result;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answer).toBeNull();

    const conn2 =
      server.connections.at(-1) === conn
        ? await server.nextConnection()
        : server.connections.at(-1)!;
    const hello = await conn2.next('hello');
    expect(hello.jobs).toEqual([{ jobId: 'job-4', state: 'running', logLineCount: 0 }]);
    conn2.send({
      type: 'welcome',
      config: config(),
      jobs: [{ jobId: 'job-4', action: 'continue', logLinesHave: 0 }],
    });
    const request = await conn2.next('agent', (f) => f.message.type === 'commit-request');
    expect(answer).toBeNull();

    const id = (request.message as { id: number }).id;
    conn2.send({
      type: 'agent',
      jobId: 'job-4',
      message: { type: 'commit-result', id, granted: true, reason: null },
    });
    await waitFor(() => answer !== null);
    expect(answer).toEqual({ granted: true, reason: null });
  });

  it('relays doc requests and resolves them with the server result', async () => {
    const { server, factory, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;

    conn.send({ type: 'job', jobId: 'job-5', payload: payloadFor('job-5', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);
    const got = factory.agents[0]!.deps.documents.get('col', 'doc');
    const request = await conn.next('agent', (f) => f.message.type === 'doc-request');
    expect(request.message).toMatchObject({ method: 'get', collection: 'col', docId: 'doc' });
    conn.send({
      type: 'agent',
      jobId: 'job-5',
      message: {
        type: 'doc-result',
        id: (request.message as { id: number }).id,
        ok: true,
        value: { a: 1 },
      },
    });
    await expect(got).resolves.toEqual({ a: 1 });
  });

  it('cancels the agent on abandon, and refuses its later commit requests locally', async () => {
    const { server, factory, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;

    conn.send({ type: 'job', jobId: 'job-6', payload: payloadFor('job-6', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);
    const agent = factory.agents[0]!;

    conn.send({ type: 'agent', jobId: 'job-6', message: { type: 'cancel' } });
    await waitFor(() => agent.cancels === 1);

    conn.send({ type: 'abandon', jobId: 'job-6', reason: 'released' });
    await waitFor(() => agent.cancels === 2);
    const answer = await agent.deps.commits!({ kind: 'replace', pluginId: 'x' });
    expect(answer.granted).toBe(false);
    expect(conn.frames.some((f) => f.type === 'agent' && f.message.type === 'commit-request')).toBe(
      false,
    );
  });

  it('waits retryAfterMs after a refusal rather than reconnecting in a hot loop', async () => {
    const { server, start } = await setup({ reconnectDelaysMs: [1] });
    const first = server.nextConnection();
    const host = await start();
    const conn = await first;
    await conn.next('hello');
    const refusedAt = Date.now();
    conn.send({ type: 'refused', reason: 'protocol mismatch', retryAfterMs: 50 });
    conn.ws.close(4002, 'protocol version mismatch');

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.connections.length).toBeLessThanOrEqual(2);
    expect(server.connections.length).toBe(2);
    expect(server.connectionTimes[1]! - refusedAt).toBeGreaterThanOrEqual(45);
    void host;
  });

  it('probes libraries: unmapped roots and missing directories are unreachable with a reason', async () => {
    const { server, start } = await setup();
    const present = mkdtempSync(join(tmpdir(), 'trawlarr-node-lib-'));
    const missing = join(present, 'does-not-exist');
    const host = await start();
    const { conn } = await welcome(
      server,
      [],
      [
        { libraryId: 'ok', name: 'OK', nodeRoots: [present] },
        { libraryId: 'unmapped', name: 'U', nodeRoots: [present, null] },
        { libraryId: 'missing', name: 'M', nodeRoots: [missing] },
      ],
    );
    await host.started;

    const frame = await conn.next('libraries');
    const byId = new Map(frame.libraries.map((probe) => [probe.libraryId, probe]));
    expect(byId.get('ok')).toMatchObject({ reachable: true });
    expect(byId.get('unmapped')).toMatchObject({ reachable: false });
    // Printed verbatim on the node's card.
    expect(byId.get('unmapped')!.detail).toBe('no path on this node');
    expect(byId.get('unmapped')!.detail).not.toMatch(/mapped/i);
    expect(byId.get('missing')).toMatchObject({ reachable: false });
    expect(byId.get('missing')!.detail).toContain('ENOENT');
  });

  it('backfills log lines the server does not have on a continue', async () => {
    // A slower reconnect, so the lines are logged before the next hello counts them.
    const { server, factory, start } = await setup({ reconnectDelaysMs: [150] });
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;

    conn.send({ type: 'job', jobId: 'job-7', payload: payloadFor('job-7', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);
    conn.ws.terminate();
    await waitFor(() => !host.status().connected);
    for (const line of ['one', 'two', 'three']) factory.agents[0]!.deps.onLog(line);

    const conn2 =
      server.connections.at(-1) === conn
        ? await server.nextConnection()
        : server.connections.at(-1)!;
    const hello = await conn2.next('hello');
    expect(hello.jobs).toEqual([{ jobId: 'job-7', state: 'running', logLineCount: 3 }]);
    conn2.send({
      type: 'welcome',
      config: config(),
      jobs: [{ jobId: 'job-7', action: 'continue', logLinesHave: 1 }],
    });
    const backfill = await conn2.next('log-backfill');
    expect(backfill).toEqual({
      type: 'log-backfill',
      jobId: 'job-7',
      fromLine: 1,
      lines: ['two', 'three'],
    });
  });

  it('refuses a second host on the same data directory', async () => {
    const { start, dataDir } = await setup();
    await start();
    await expect(start({ dataDir })).rejects.toThrow(/node\.lock|already/);
  });

  it('rejects when there is no node state and nothing to enroll with', async () => {
    const { start } = await setup({ enrollToken: undefined });
    await expect(start()).rejects.toThrow(/--server.*--token|--token.*--server/);
  });

  it('reports the cancelled failure when the server-requested cancel stops the agent', async () => {
    const { server, factory, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;
    conn.send({ type: 'job', jobId: 'job-8', payload: payloadFor('job-8', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);
    factory.agents[0]!.reject(
      new AgentFailure('Worker job-8 reported failure: stopped', {
        reported: true,
        cancelled: true,
      }),
    );
    const failed = await conn.next('agent', (f) => f.message.type === 'failed');
    expect(failed.message).toMatchObject({ type: 'failed', error: 'stopped' });
  });

  /** Drop the welcomed socket and return the reconnect, once its hello has arrived. */
  const reconnect = async (server: FakeServer, conn: FakeConnection, host: NodeHost) => {
    const next = server.nextConnection();
    conn.ws.terminate();
    await waitFor(() => !host.status().connected);
    const conn2 = server.connections.at(-1) !== conn ? server.connections.at(-1)! : await next;
    const hello = await conn2.next('hello');
    return { conn2, hello };
  };

  it('delivers a report held between hello and welcome once the welcome continues the job', async () => {
    const { server, factory, dataDir, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;
    conn.send({ type: 'job', jobId: 'job-9', payload: payloadFor('job-9', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);

    const { conn2, hello } = await reconnect(server, conn, host);
    expect(hello.jobs).toEqual([{ jobId: 'job-9', state: 'running', logLineCount: 0 }]);

    // The run finishes after hello and before welcome: held, but not sendable yet.
    factory.agents[0]!.resolve(reportFor('job-9'));
    await waitFor(
      () =>
        (
          JSON.parse(readFileSync(join(dataDir, 'journal', 'job-9.json'), 'utf8')) as {
            state: string;
          }
        ).state === 'held-report',
    );
    expect(conn2.frames.some((f) => f.type === 'agent')).toBe(false);

    conn2.send({
      type: 'welcome',
      config: config(),
      jobs: [{ jobId: 'job-9', action: 'continue', logLinesHave: 0 }],
    });
    const done = await conn2.next('agent', (f) => f.message.type === 'done');
    expect(done.jobId).toBe('job-9');
  });

  it('stops by killing agents, sending no final, and leaving the job to be reported lost', async () => {
    const { server, factory, dataDir, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;
    conn.send({ type: 'job', jobId: 'job-10', payload: payloadFor('job-10', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);

    await host.stop();

    expect(factory.agents[0]!.kills).toBe(1);
    expect(factory.agents[0]!.cancels).toBe(0);
    expect(
      conn.frames.some(
        (f) => f.type === 'agent' && (f.message.type === 'failed' || f.message.type === 'done'),
      ),
    ).toBe(false);
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'journal', 'job-10.json'), 'utf8')) as {
      state: string;
      final: unknown;
    };
    expect(onDisk).toMatchObject({ state: 'running', final: null });
    expect(createJournal(join(dataDir, 'journal')).load()).toEqual([
      { jobId: 'job-10', state: 'lost', logLineCount: 0 },
    ]);
  });

  it("acts on a welcome's abandon: cancels, forgets the entry, refuses commits, sends nothing later", async () => {
    const { server, factory, dataDir, start } = await setup();
    const host = await start();
    const { conn } = await welcome(server);
    await host.started;
    conn.send({ type: 'job', jobId: 'job-11', payload: payloadFor('job-11', server.bundle) });
    await waitFor(() => factory.agents[0]?.payload != null);
    const agent = factory.agents[0]!;

    const { conn2 } = await reconnect(server, conn, host);
    conn2.send({
      type: 'welcome',
      config: config(),
      jobs: [{ jobId: 'job-11', action: 'abandon', logLinesHave: 0 }],
    });
    await waitFor(() => agent.cancels === 1);
    expect(existsSync(join(dataDir, 'journal', 'job-11.json'))).toBe(false);
    expect((await agent.deps.commits!({ kind: 'replace', pluginId: 'x' })).granted).toBe(false);

    agent.reject(new AgentFailure('Worker job-11 reported failure: cancelled', { reported: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(conn2.frames.some((f) => f.type === 'agent')).toBe(false);
    expect(existsSync(join(dataDir, 'journal', 'job-11.json'))).toBe(false);
  });

  it("acts on a welcome's lost: removes a job this node lost in a restart", async () => {
    const dataDir = newDataDir();
    createJournal(join(dataDir, 'journal')).begin('job-12', 1);
    const { server, start } = await setup({ dataDir });
    const connecting = server.nextConnection();
    await start();
    const conn = await connecting;
    const hello = await conn.next('hello');
    expect(hello.jobs).toEqual([{ jobId: 'job-12', state: 'lost', logLineCount: 0 }]);

    conn.send({
      type: 'welcome',
      config: config(),
      jobs: [{ jobId: 'job-12', action: 'lost', logLinesHave: 0 }],
    });
    await waitFor(() => !existsSync(join(dataDir, 'journal', 'job-12.json')));
  });

  it('treats an enroll 4xx other than 401 as a setup error naming the status and URL', async () => {
    const { server, start } = await setup();
    const host = await start({ serverUrl: `${server.url}/not-trawlarr` });
    await expect(host.started).rejects.toThrow(/HTTP 404/);
    await expect(host.started).rejects.toThrow(`${server.url}/not-trawlarr/api/v1/nodes/enroll`);
  });

  it('releases the lock when start fails after taking it', async () => {
    const { start, dataDir } = await setup();
    // A file where the journal directory belongs makes the journal fail to open.
    writeFileSync(join(dataDir, 'journal'), 'not a directory');
    await expect(start()).rejects.toThrow();

    rmSync(join(dataDir, 'journal'));
    // Would reject with the lock error had the failed start kept the lock.
    await expect(start()).resolves.toBeDefined();
  });
});
