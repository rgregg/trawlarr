import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEventBus, type EventBus, type TrawlarrEvent } from '../daemon/events.js';
import type { ScanCoordinator } from '../daemon/scan-coordinator.js';
import type { Supervisor, SupervisorStatus } from '../daemon/supervisor.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createJobRepo, MAX_LOG_EXCERPT_CHARS } from '../db/job-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createSettingsRepo, type SettingsRepo } from '../db/settings-repo.js';
import { createApiContext, createApiServer } from './server.js';
import {
  attachWebSocket,
  SLOW_CLIENT_DROP_BYTES,
  SLOW_CLIENT_TERMINATE_BYTES,
  WS_OPEN,
  type PushSocket,
  type WsChannel,
} from './ws.js';

/** A real data directory for the context, as `createApiContext` requires. */
const API_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'trawlarr-ws-data-'));

const NOW = 1_700_000_000_000;
const API_KEY = 'the-fixed-test-api-key-000000';

const VALID_FLOW: FlowDefinition = {
  nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
};

const fakeSupervisor = (): Supervisor => ({
  tick: async () => {
    await Promise.resolve();
  },
  status: (): SupervisorStatus => ({
    target: { transcode: 1, health: 0 },
    workers: [],
    paused: false,
  }),
  pause: () => {},
  resume: () => {},
  cancelJob: () => false,
  drain: async () => {
    await Promise.resolve();
  },
  stop: async () => {
    await Promise.resolve();
  },
});

const fakeScans = (): ScanCoordinator => ({
  request: () => {},
  syncWatchers: () => {},
  idle: async () => {
    await Promise.resolve();
  },
  start: () => {},
  stop: async () => {
    await Promise.resolve();
  },
  scanning: () => [],
});

/**
 * A socket this channel can push to, whose backlog the test chooses.
 *
 * The backpressure rule is "when `bufferedAmount` is above the cap", and
 * there is no way to make a real kernel socket buffer a megabyte on demand
 * without writing a megabyte and hoping — which would be a test that
 * asserts on timing. So the cap is driven through the one seam the real
 * upgrade path also goes through, and a real socket proves the wire.
 */
interface FakeSocket extends PushSocket {
  readonly sent: TrawlarrEvent[];
  readonly rawSent: string[];
  terminated: boolean;
  closedWith: { code?: number; reason?: string } | null;
  backlog: number;
  state: number;
  fire(event: 'close' | 'error'): void;
}

const fakeSocket = (options: { bufferedAmount?: number } = {}): FakeSocket => {
  const rawSent: string[] = [];
  const handlers: Record<'close' | 'error', (() => void)[]> = { close: [], error: [] };

  const socket: FakeSocket = {
    rawSent,
    get sent() {
      return rawSent.map((raw) => JSON.parse(raw) as TrawlarrEvent);
    },
    terminated: false,
    closedWith: null,
    backlog: options.bufferedAmount ?? 0,
    state: WS_OPEN,
    get bufferedAmount() {
      return socket.backlog;
    },
    get readyState() {
      return socket.state;
    },
    send: (data: string) => {
      rawSent.push(data);
    },
    close: (code?: number, reason?: string) => {
      socket.closedWith = { code, reason };
    },
    terminate: () => {
      socket.terminated = true;
      socket.state = 3;
    },
    on: (event: 'close' | 'error', listener: () => void) => {
      handlers[event].push(listener);
    },
    fire: (event: 'close' | 'error') => {
      for (const listener of [...handlers[event]]) listener();
    },
  };
  return socket;
};

/**
 * Yields to the event loop until the CONDITION holds.
 *
 * `setImmediate` rather than a timer: this hands control back so pending
 * I/O can run, and returns the instant the predicate is true. The deadline
 * is a failure bound so a broken build reports rather than hangs — nothing
 * here ever waits a fixed duration for something to arrive.
 */
const waitFor = async (predicate: () => boolean, what = 'condition'): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Opens a real client socket; rejects with the handshake status on refusal. */
const connect = async (url: string, headers?: Record<string, string>): Promise<WebSocket> =>
  await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, headers === undefined ? undefined : { headers });
    socket.on('open', () => {
      resolve(socket);
    });
    socket.on('unexpected-response', (_req, res) => {
      reject(new Error(`handshake refused with ${String(res.statusCode)}`));
    });
    socket.on('error', (error: Error) => {
      reject(error);
    });
  });

/** Everything one client received, in arrival order. */
const collect = (socket: WebSocket): TrawlarrEvent[] => {
  const received: TrawlarrEvent[] = [];
  socket.on('message', (data: Buffer) => {
    received.push(JSON.parse(String(data)) as TrawlarrEvent);
  });
  return received;
};

const jobStarted = (jobId: string): TrawlarrEvent => ({
  type: 'job.started',
  jobId,
  fileId: 'f',
  libraryId: 'l',
  path: '/media/a.mkv',
  workerId: 'w1',
  pid: 4242,
});

const jobFinished = (jobId: string): TrawlarrEvent => ({
  type: 'job.finished',
  jobId,
  fileId: 'f',
  state: 'good',
  outcome: 'ok',
});

let db: Db;
let settings: SettingsRepo;
let bus: EventBus;
let server: Server;
let channel: WsChannel;
let port: number;
let baseUrl: string;
let openSockets: WebSocket[];

const eventsUrl = (query = `?apiKey=${API_KEY}`): string =>
  `ws://127.0.0.1:${String(port)}/api/v1/events${query}`;

const open = async (query?: string, headers?: Record<string, string>): Promise<WebSocket> => {
  const socket = await connect(eventsUrl(query), headers);
  openSockets.push(socket);
  return socket;
};

/**
 * A parsed JSON response body, deliberately loose — these assertions are
 * about the API's answer, and restating its types here would check the
 * restatement.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResponseBody = any;

const api = async (
  method: string,
  path: string,
): Promise<{ status: number; body: ResponseBody }> => {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { 'x-api-key': API_KEY },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
};

beforeEach(async () => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  settings = createSettingsRepo({ db, generateApiKey: () => API_KEY });
  bus = createEventBus();
  openSockets = [];

  const ctx = createApiContext({
    db,
    settings,
    bus,
    supervisor: fakeSupervisor(),
    scans: fakeScans(),
    nowMs: () => NOW,
    version: '0.0.0-test',
    dataDir: API_TEST_DATA_DIR,
  });

  server = createApiServer(ctx, { onError: () => {} });
  channel = attachWebSocket({ server, bus, settings });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${String(port)}`;
});

afterEach(async () => {
  for (const socket of openSockets) socket.terminate();
  await channel.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('over a real socket', () => {
  it('rejects an upgrade with no api key', async () => {
    await expect(connect(`ws://127.0.0.1:${String(port)}/api/v1/events`)).rejects.toMatchObject({
      message: expect.stringContaining('401'),
    });
    expect(channel.clientCount()).toBe(0);
  });

  it('rejects an upgrade with a wrong api key, and never opens the socket', async () => {
    await expect(open('?apiKey=not-the-key')).rejects.toMatchObject({
      message: expect.stringContaining('401'),
    });
    expect(channel.clientCount()).toBe(0);
  });

  it('accepts the key in the X-Api-Key header, for a client that can set one', async () => {
    const socket = await open('', { 'x-api-key': API_KEY });
    const received = collect(socket);

    bus.emit(jobStarted('j1'));
    await waitFor(() => received.length === 1, 'the header-authenticated client to receive');

    expect(received[0]!.type).toBe('job.started');
  });

  it('refuses an upgrade on any other path', async () => {
    await expect(connect(`ws://127.0.0.1:${String(port)}/api/v1/elsewhere`)).rejects.toMatchObject({
      message: expect.stringContaining('404'),
    });
  });

  it('delivers events published on the bus, in order', async () => {
    const socket = await open();
    const received = collect(socket);

    bus.emit(jobStarted('j1'));
    bus.emit({ type: 'job.progress', jobId: 'j1', percent: 10, stage: 'encoding' });
    bus.emit(jobFinished('j1'));
    await waitFor(() => received.length === 3, 'three frames');

    expect(received.map((event) => event.type)).toEqual([
      'job.started',
      'job.progress',
      'job.finished',
    ]);
  });

  it('gives every client the same stream, independently', async () => {
    const first = await open();
    const second = await open();
    const firstReceived = collect(first);
    const secondReceived = collect(second);
    await waitFor(() => channel.clientCount() === 2, 'two clients');

    bus.emit({ type: 'scan.progress', libraryId: 'lib', seen: 42 });

    await waitFor(
      () => firstReceived.length === 1 && secondReceived.length === 1,
      'both clients to receive',
    );
    expect(firstReceived).toEqual(secondReceived);
  });

  it('unsubscribes from the bus when a client disconnects', async () => {
    const socket = await open();
    await waitFor(() => channel.clientCount() === 1, 'the client to register');

    socket.close();
    await waitFor(() => channel.clientCount() === 0, 'the client to be forgotten');

    expect(() => {
      bus.emit(jobStarted('j2'));
    }).not.toThrow();
  });

  it('leaks no bus listener across repeated reconnects', async () => {
    for (let i = 0; i < 5; i += 1) {
      const socket = await connect(eventsUrl());
      await waitFor(() => channel.clientCount() === 1, 'the client to register');
      socket.close();
      await waitFor(() => channel.clientCount() === 0, 'the client to be forgotten');
    }

    const socket = await open();
    const received = collect(socket);
    bus.emit(jobStarted('j3'));
    await waitFor(() => received.length === 1, 'the surviving client to receive');

    // One live client, one delivery: the five dead ones are not still
    // subscribed under another name.
    expect(channel.clientCount()).toBe(1);
    expect(received).toHaveLength(1);
  });

  it('closes every client and stops pushing when the channel closes', async () => {
    const socket = await open();
    const received = collect(socket);
    const closed = new Promise<number>((resolve) => socket.on('close', resolve));
    await waitFor(() => channel.clientCount() === 1, 'the client to register');

    await channel.close();

    expect(await closed).toBe(1001);
    expect(channel.clientCount()).toBe(0);
    bus.emit(jobStarted('j4'));
    expect(received).toHaveLength(0);

    // And the upgrade listener is gone with it: a new client is refused,
    // rather than hanging on a handshake nobody will answer.
    await expect(connect(eventsUrl())).rejects.toBeInstanceOf(Error);
  });
});

describe('a slow client', () => {
  const attachWithFakeSocket = (options: { bufferedAmount: number }): FakeSocket => {
    const socket = fakeSocket(options);
    channel.accept(socket);
    return socket;
  };

  it('drops log and progress events for a backed-up client but keeps state transitions', () => {
    const socket = attachWithFakeSocket({ bufferedAmount: SLOW_CLIENT_DROP_BYTES + 1 });

    bus.emit({ type: 'job.log', jobId: 'j', text: 'x' });
    bus.emit({ type: 'job.progress', jobId: 'j', percent: 10, stage: 'encoding' });
    bus.emit({ type: 'job.finished', jobId: 'j', fileId: 'f', state: 'good', outcome: 'ok' });

    expect(socket.sent.map((event) => event.type)).toEqual(['job.finished']);
  });

  it('sends everything to a client that is keeping up', () => {
    const socket = attachWithFakeSocket({ bufferedAmount: SLOW_CLIENT_DROP_BYTES - 1 });

    bus.emit({ type: 'job.log', jobId: 'j', text: 'x' });
    bus.emit({ type: 'job.progress', jobId: 'j', percent: 10, stage: 'encoding' });
    bus.emit(jobFinished('j'));

    expect(socket.sent.map((event) => event.type)).toEqual([
      'job.log',
      'job.progress',
      'job.finished',
    ]);
  });

  it('does not let one backed-up client cost another client its events', () => {
    const stalled = attachWithFakeSocket({ bufferedAmount: SLOW_CLIENT_DROP_BYTES + 1 });
    const healthy = attachWithFakeSocket({ bufferedAmount: 0 });

    bus.emit({ type: 'job.progress', jobId: 'j', percent: 10, stage: 'encoding' });
    bus.emit(jobFinished('j'));

    expect(stalled.sent.map((event) => event.type)).toEqual(['job.finished']);
    expect(healthy.sent.map((event) => event.type)).toEqual(['job.progress', 'job.finished']);
  });

  it('disconnects a client whose backlog grows past the hard cap, and unsubscribes it', () => {
    const socket = attachWithFakeSocket({ bufferedAmount: SLOW_CLIENT_TERMINATE_BYTES + 1 });
    expect(channel.clientCount()).toBe(1);

    bus.emit(jobFinished('j'));

    expect(socket.terminated).toBe(true);
    expect(socket.sent).toEqual([]);
    expect(channel.clientCount()).toBe(0);

    // Nothing is queued for it afterwards: the daemon's memory is bounded
    // by dropping the client, not by holding its backlog.
    socket.backlog = 0;
    socket.state = WS_OPEN;
    bus.emit(jobFinished('j'));
    expect(socket.sent).toEqual([]);
  });

  it('caps a log tail at the same size the database caps a step excerpt', () => {
    const socket = attachWithFakeSocket({ bufferedAmount: 0 });

    bus.emit({ type: 'job.log', jobId: 'j', text: 'x'.repeat(MAX_LOG_EXCERPT_CHARS * 3) });

    const [event] = socket.sent;
    expect(event?.type).toBe('job.log');
    const text = (event as { text: string }).text;
    expect(text.length).toBeLessThan(MAX_LOG_EXCERPT_CHARS + 100);
    expect(text).toContain('truncated');
  });

  it('never pushes to a socket that is no longer open', () => {
    const socket = attachWithFakeSocket({ bufferedAmount: 0 });
    socket.state = 3;

    bus.emit(jobFinished('j'));

    expect(socket.sent).toEqual([]);
  });

  it('survives a socket whose send throws, without unwinding into the emitter', () => {
    const exploding = fakeSocket();
    exploding.send = () => {
      throw new Error('EPIPE');
    };
    channel.accept(exploding);
    const healthy = attachWithFakeSocket({ bufferedAmount: 0 });

    expect(() => {
      bus.emit(jobFinished('j'));
    }).not.toThrow();
    expect(healthy.sent).toHaveLength(1);
  });

  it('forgets a client on error as well as on close', () => {
    const socket = attachWithFakeSocket({ bufferedAmount: 0 });
    expect(channel.clientCount()).toBe(1);

    socket.fire('error');
    socket.fire('close');

    expect(channel.clientCount()).toBe(0);
  });
});

describe('a dropped socket costs liveness, never correctness', () => {
  it('gives a client that missed every single event the whole truth over REST', async () => {
    // This client connects and immediately goes away, so it observes
    // nothing at all — the worst case the spec's rule has to survive.
    const socket = await connect(eventsUrl());
    const received = collect(socket);
    socket.close();
    await waitFor(() => channel.clientCount() === 0, 'the client to disconnect');

    // Meanwhile the daemon does real work: a job runs to completion, with a
    // step trace, and a library is paused.
    const library = createLibraryRepo(db).create({
      name: 'Movies',
      roots: ['/media/movies'],
      flowId: null,
      nowMs: NOW,
    });
    const flow = createFlowRepo(db).create({
      name: 'flow-a',
      definition: VALID_FLOW,
      nowMs: NOW,
    });
    const fileId = randomUUID();
    db.prepare(
      `INSERT INTO media_file (
         id, library_id, inode_key, content_key, path, nlink, size_bytes, mtime_ms, ctime_ms,
         container, state, discovered_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 1000, ?, ?, 'mkv', 'queued', ?, ?)`,
    ).run(
      fileId,
      library.id,
      `inode-${fileId}`,
      `content-${fileId}`,
      '/media/movies/a.mkv',
      NOW,
      NOW,
      NOW,
      NOW,
    );

    const jobs = createJobRepo(db);
    const jobId = jobs.start({
      fileId,
      flowId: flow.id,
      flowHash: flow.definitionHash,
      nowMs: NOW,
    });
    bus.emit(jobStarted(jobId));
    jobs.recordStep({
      jobId,
      step: {
        seq: 1,
        nodeId: 'start',
        pluginId: 'trawlarr:start',
        outputNumber: 1,
        durationMs: 12,
        logExcerpt: 'encoded with libx265',
      },
    });
    bus.emit({
      type: 'job.step',
      jobId,
      seq: 1,
      pluginId: 'trawlarr:start',
      outputNumber: 1,
      durationMs: 12,
    });
    bus.emit({ type: 'job.log', jobId, text: 'encoded with libx265' });
    jobs.finish({ jobId, state: 'success', outcome: 'transcoded', nowMs: NOW + 1000 });
    bus.emit({ type: 'job.finished', jobId, fileId, state: 'good', outcome: 'transcoded' });

    await api('POST', `/libraries/${library.id}/pause`);

    // It saw nothing…
    expect(received).toEqual([]);

    // …and every fact those frames carried is still fetchable.
    const detail = await api('GET', `/jobs/${jobId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.job).toMatchObject({
      id: jobId,
      fileId,
      state: 'success',
      outcome: 'transcoded',
    });
    expect(detail.body.steps).toHaveLength(1);
    expect(detail.body.steps[0]).toMatchObject({
      seq: 1,
      pluginId: 'trawlarr:start',
      durationMs: 12,
    });
    expect(detail.body.steps[0].logExcerpt).toContain('libx265');

    const list = await api('GET', `/jobs?fileId=${fileId}`);
    expect(list.body.items.map((job: { id: string }) => job.id)).toEqual([jobId]);

    const libraries = await api('GET', '/libraries');
    expect(libraries.body[0]).toMatchObject({ id: library.id, paused: true });
  });

  it('lets a client that reconnects simply re-fetch, with no replay owed to it', async () => {
    const first = await open();
    first.close();
    await waitFor(() => channel.clientCount() === 0, 'the first client to disconnect');

    bus.emit(jobStarted('missed-job'));

    const second = await open();
    const received = collect(second);
    await waitFor(() => channel.clientCount() === 1, 'the reconnected client');

    // No backfill frame, no resume cursor, no replay: what happened while
    // it was away is REST's job, and only new events arrive here.
    bus.emit(jobFinished('later-job'));
    await waitFor(() => received.length === 1, 'the live frame');
    expect(received.map((event) => event.type)).toEqual(['job.finished']);
  });
});
