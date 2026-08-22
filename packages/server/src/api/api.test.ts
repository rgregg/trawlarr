import { mkdtemp, mkdir, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEventBus, type TrawlarrEvent } from '../daemon/events.js';
import type { ScanCoordinator, ScanReason } from '../daemon/scan-coordinator.js';
import type { Supervisor, SupervisorStatus } from '../daemon/supervisor.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { createSettingsRepo, type SettingsRepo } from '../db/settings-repo.js';
import { createPluginRepo } from '../plugins/plugin-repo.js';
import { createApiContext, createApiServer } from './server.js';
import { createPluginLoader } from '@trawlarr/engine';

const NOW = 1_700_000_000_000;
const API_KEY = 'the-fixed-test-api-key-000000';

const VALID_FLOW: FlowDefinition = {
  nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
};

/**
 * Two independent defects in one definition: two nodes both declaring
 * themselves the start node, and an edge pointing at a node that is not in
 * the flow. One problem each, so a validator that reported only the first
 * would be visible.
 */
const FLOW_WITH_TWO_PROBLEMS: FlowDefinition = {
  nodes: [
    { id: 'start-a', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'start-b', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
  ],
  edges: [{ fromNodeId: 'start-a', toNodeId: 'ghost', outputNumber: 1 }],
};

const flowUsing = (pluginId: string): FlowDefinition => ({
  nodes: [{ id: 'n1', pluginId, pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
});

/** A supervisor that records what it was asked to do, and nothing else. */
interface FakeSupervisor extends Supervisor {
  cancelled: string[];
  ticks: number;
  running: Set<string>;
}

const fakeSupervisor = (running: string[] = []): FakeSupervisor => {
  const cancelled: string[] = [];
  const live = new Set(running);
  let ticks = 0;
  let paused = false;

  return {
    cancelled,
    running: live,
    get ticks() {
      return ticks;
    },
    tick: async () => {
      ticks += 1;
      await Promise.resolve();
    },
    status: (): SupervisorStatus => ({
      target: { transcode: 1, health: 0 },
      workers: [...live].map((jobId) => ({
        id: `worker-${jobId}`,
        workerClass: 'transcode',
        hardwareType: 'cpu',
        jobId,
        fileId: null,
        path: null,
        startedAtMs: NOW,
        pid: 1234,
      })),
      paused,
    }),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    cancelJob: (jobId: string) => {
      if (!live.has(jobId)) return false;
      cancelled.push(jobId);
      live.delete(jobId);
      return true;
    },
    drain: async () => {
      await Promise.resolve();
    },
    stop: async () => {
      await Promise.resolve();
    },
  };
};

interface FakeScans extends ScanCoordinator {
  requests: { libraryId: string; reason: ScanReason }[];
  /** How many times the API asked the coordinator to re-derive its watches. */
  syncs: number;
}

const fakeScans = (): FakeScans => {
  const requests: { libraryId: string; reason: ScanReason }[] = [];
  const fake = {
    requests,
    syncs: 0,
    request: (libraryId: string, reason: ScanReason) => {
      requests.push({ libraryId, reason });
    },
    syncWatchers: () => {
      fake.syncs += 1;
    },
    idle: async () => {
      await Promise.resolve();
    },
    start: () => {},
    stop: async () => {
      await Promise.resolve();
    },
    scanning: () => [],
  };
  return fake;
};

let db: Db;
let settings: SettingsRepo;
let supervisor: FakeSupervisor;
let scans: FakeScans;
let events: TrawlarrEvent[];
let server: Server;
let baseUrl: string;

/**
 * A parsed JSON response body, deliberately loose. These tests assert the
 * shapes the API's own types define; restating those types here would check
 * the restatement rather than the API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResponseBody = any;

interface Result {
  status: number;
  headers: Headers;
  body: ResponseBody;
}

/** Drives the API over a real socket, which is the only path production uses. */
const api = async (
  method: string,
  path: string,
  body?: unknown,
  options: { apiKey?: string | null } = {},
): Promise<Result> => {
  const key = options.apiKey === undefined ? API_KEY : options.apiKey;
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(key === null ? {} : { 'x-api-key': key }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
  };
};

const seedLibrary = (over: { name?: string; roots?: string[]; flowId?: string | null } = {}) =>
  createLibraryRepo(db).create({
    name: over.name ?? `lib-${randomUUID().slice(0, 8)}`,
    roots: over.roots ?? [`/media/${randomUUID().slice(0, 8)}`],
    flowId: over.flowId ?? null,
    nowMs: NOW,
  });

const seedFile = (input: {
  libraryId: string;
  path: string;
  state?: string;
  missingSinceMs?: number | null;
  updatedAt?: number;
}): string => {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_file (
       id, library_id, inode_key, content_key, path, nlink, size_bytes, mtime_ms, ctime_ms,
       container, state, missing_since_ms, discovered_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, 1000, ?, ?, 'mkv', ?, ?, ?, ?)`,
  ).run(
    id,
    input.libraryId,
    `inode-${id}`,
    `content-${id}`,
    input.path,
    NOW,
    NOW,
    input.state ?? 'queued',
    input.missingSinceMs ?? null,
    NOW,
    input.updatedAt ?? NOW,
  );
  return id;
};

beforeEach(async () => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  settings = createSettingsRepo({ db, generateApiKey: () => API_KEY });
  supervisor = fakeSupervisor();
  scans = fakeScans();
  const bus = createEventBus();
  events = [];
  bus.subscribe((event) => events.push(event));

  const ctx = createApiContext({
    db,
    settings,
    bus,
    supervisor,
    scans,
    nowMs: () => NOW,
    version: '0.0.0-test',
    // A seam, so this suite never depends on what is installed on the
    // machine running it.
    checkBinary: async (path) => await Promise.resolve(path.includes('ffmpeg')),
  });

  server = createApiServer(ctx, { onError: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('over a real socket', () => {
  it('serves health with no key, and refuses everything else without one', async () => {
    const health = await api('GET', '/system/health', undefined, { apiKey: null });
    const libraries = await api('GET', '/libraries', undefined, { apiKey: null });

    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(libraries.status).toBe(401);
    expect(libraries.body.error.code).toBe('unauthorized');
  });

  it('does not create a library for an unauthorised request, and says so identically for a missing and a wrong key', async () => {
    const missing = await api(
      'POST',
      '/libraries',
      { name: 'Movies', roots: ['/m'] },
      {
        apiKey: null,
      },
    );
    const wrong = await api(
      'POST',
      '/libraries',
      { name: 'Movies', roots: ['/m'] },
      {
        apiKey: 'wrong-key-entirely-0000000000',
      },
    );

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(missing.body);
    // The observable half: no row was written by either attempt.
    expect(createLibraryRepo(db).list()).toHaveLength(0);
  });
});

describe('libraries', () => {
  it('creates a library and reports stats for it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trawlarr-api-'));
    const created = await api('POST', '/libraries', { name: 'Movies', roots: [root] });

    expect(created.status).toBe(201);
    expect(createLibraryRepo(db).getById(created.body.id)).not.toBeNull();

    const stats = await api('GET', `/libraries/${created.body.id}/stats`);
    expect(stats.body).toMatchObject({ total: 0, good: 0, convergedPercent: 0 });
  });

  it('reports a convergence percentage that is floored, never rounded up', async () => {
    const library = seedLibrary();
    // 249 good of 250: 99.6%, which must not read as 100%.
    for (let i = 0; i < 249; i += 1) {
      seedFile({ libraryId: library.id, path: `/media/good-${i}.mkv`, state: 'good' });
    }
    seedFile({ libraryId: library.id, path: '/media/queued.mkv', state: 'queued' });

    const { body } = await api('GET', `/libraries/${library.id}/stats`);

    // The NUMBER, not a formatted substring: '100% converged'.includes('0% converged') is true.
    expect(body.convergedPercent).toBe(99);
  });

  it('reports 100 only when every tracked file is good', async () => {
    const library = seedLibrary();
    seedFile({ libraryId: library.id, path: '/media/a.mkv', state: 'good' });

    const { body } = await api('GET', `/libraries/${library.id}/stats`);

    expect(body.convergedPercent).toBe(100);
  });

  it('answers a missing library with 404 and a code a client can branch on', async () => {
    const response = await api('GET', '/libraries/not-a-real-id');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('library-not-found');
  });

  it('refuses a library whose roots overlap one that already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trawlarr-api-'));
    await api('POST', '/libraries', { name: 'First', roots: [root] });

    const second = await api('POST', '/libraries', { name: 'Second', roots: [join(root, 'sub')] });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('overlapping-roots');
    expect(createLibraryRepo(db).list()).toHaveLength(1);
  });

  it('queues a scan and returns 202 rather than holding the connection open', async () => {
    const library = seedLibrary();

    const response = await api('POST', `/libraries/${library.id}/scan`);

    expect(response.status).toBe(202);
    expect(scans.requests).toEqual([{ libraryId: library.id, reason: 'manual' }]);
  });

  it('edits a library, and the row really changes', async () => {
    const library = seedLibrary();

    const response = await api('PATCH', `/libraries/${library.id}`, {
      extensions: ['mkv'],
      allowHardlinked: true,
    });

    expect(response.status).toBe(200);
    const after = createLibraryRepo(db).getById(library.id)!;
    expect(after.extensions).toEqual(['mkv']);
    expect(after.allowHardlinked).toBe(true);
  });

  /**
   * The defect the daemon end-to-end suite found. Watchers were derived once,
   * at daemon start, so a library created through the API — the only way a UI
   * creates one — was never watched: a file dropped into it sat undiscovered
   * until the periodic rescan, up to an hour later. Both halves are asserted
   * here, because both were missing: the watch, and the initial walk.
   */
  it('watches and scans a library created through the API, without waiting for the rescan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trawlarr-api-'));

    const created = await api('POST', '/libraries', { name: 'Movies', roots: [root] });

    expect(scans.syncs).toBeGreaterThan(0);
    expect(scans.requests).toEqual([{ libraryId: created.body.id, reason: 'startup' }]);
  });

  it('re-derives its watches and rescans when a library gets a different flow', async () => {
    const flow = createFlowRepo(db).create({ name: 'f', definition: VALID_FLOW, nowMs: NOW });
    const library = seedLibrary();
    const syncsBefore = scans.syncs;

    await api('PATCH', `/libraries/${library.id}`, { flowId: flow.id });

    expect(scans.syncs).toBeGreaterThan(syncsBefore);
    // What a file must contain changed, so the library is re-walked now
    // rather than at the next hourly rescan.
    expect(scans.requests).toEqual([{ libraryId: library.id, reason: 'manual' }]);
  });

  it('does not walk a whole library just because it was renamed', async () => {
    const library = seedLibrary();

    await api('PATCH', `/libraries/${library.id}`, { name: 'renamed' });

    // A walk of a 100,000-file library is not the right cost for an edit
    // that cannot have changed what any file must contain.
    expect(scans.requests).toEqual([]);
  });

  it('closes the watch of a deleted library', async () => {
    const library = seedLibrary();
    const syncsBefore = scans.syncs;

    await api('DELETE', `/libraries/${library.id}`);

    expect(scans.syncs).toBeGreaterThan(syncsBefore);
  });

  it('deletes a library and its files with it', async () => {
    const library = seedLibrary();
    const fileId = seedFile({ libraryId: library.id, path: '/media/a.mkv' });

    const response = await api('DELETE', `/libraries/${library.id}`);

    expect(response.status).toBe(204);
    expect(createLibraryRepo(db).getById(library.id)).toBeNull();
    expect(createMediaFileRepo(db).getById(fileId)).toBeNull();
  });
});

describe('a paused library says why, in terms of what it costs', () => {
  it('surfaces the flow-invalid reason and its consequence on the library listing', async () => {
    const flow = createFlowRepo(db).create({
      name: 'broken',
      definition: flowUsing('community:doesNotExist'),
      nowMs: NOW,
    });
    const library = seedLibrary({ flowId: flow.id });
    // The health check is what writes the reason; the API is what shows it.
    await api('PATCH', `/libraries/${library.id}`, {});

    const listed = (await api('GET', '/libraries')).body[0];

    expect(listed.paused).toBe(true);
    expect(listed.pausedBy).toBe('flow');
    expect(listed.pausedReason).toContain('community:doesNotExist');
    expect(listed.pausedExplanation).toContain('community:doesNotExist');
    expect(listed.pausedExplanation).toContain('nothing in this library converges');
  });

  it('surfaces the same reason on the single-library and stats endpoints', async () => {
    const flow = createFlowRepo(db).create({
      name: 'broken',
      definition: flowUsing('community:doesNotExist'),
      nowMs: NOW,
    });
    const library = seedLibrary({ flowId: flow.id });
    await api('PATCH', `/libraries/${library.id}`, {});

    const one = await api('GET', `/libraries/${library.id}`);
    const stats = await api('GET', `/libraries/${library.id}/stats`);

    expect(one.body.pausedExplanation).toContain('community:doesNotExist');
    expect(stats.body.paused).toBe(true);
    expect(stats.body.pausedExplanation).toContain('community:doesNotExist');
  });

  it('refuses to resume a library paused by flow validation, naming the plugin', async () => {
    const flow = createFlowRepo(db).create({
      name: 'broken',
      definition: flowUsing('community:doesNotExist'),
      nowMs: NOW,
    });
    const library = seedLibrary({ flowId: flow.id });
    await api('PATCH', `/libraries/${library.id}`, {});

    const response = await api('POST', `/libraries/${library.id}/resume`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('flow-invalid');
    expect(response.body.error.message).toContain('community:doesNotExist');
    // And it really is still paused.
    expect(createLibraryRepo(db).getById(library.id)!.enabled).toBe(false);
  });

  it('pauses with an operator reason that survives a health check, and resumes again', async () => {
    const flow = createFlowRepo(db).create({ name: 'ok', definition: VALID_FLOW, nowMs: NOW });
    const library = seedLibrary({ flowId: flow.id });

    const paused = await api('POST', `/libraries/${library.id}/pause`, {
      reason: 'the NAS is being rebuilt',
    });

    expect(paused.status).toBe(200);
    const row = createLibraryRepo(db).getById(library.id)!;
    expect(row.enabled).toBe(false);
    expect(row.pausedReason).toBe('operator: the NAS is being rebuilt');
    expect(paused.body.pausedBy).toBe('operator');
    expect(paused.body.pausedExplanation).toContain('the NAS is being rebuilt');
    expect(events.some((event) => event.type === 'library.paused')).toBe(true);

    const resumed = await api('POST', `/libraries/${library.id}/resume`);
    expect(resumed.status).toBe(200);
    expect(createLibraryRepo(db).getById(library.id)!.enabled).toBe(true);
    expect(events.some((event) => event.type === 'library.resumed')).toBe(true);
  });
});

describe('files', () => {
  it('pages and filters rather than returning the whole library', async () => {
    const library = seedLibrary();
    seedFile({ libraryId: library.id, path: '/media/a.mkv', state: 'good' });
    seedFile({ libraryId: library.id, path: '/media/b.mkv', state: 'queued' });
    seedFile({ libraryId: library.id, path: '/media/c.mkv', state: 'queued' });

    const page = await api('GET', `/files?libraryId=${library.id}&limit=2&offset=0`);
    const filtered = await api('GET', `/files?libraryId=${library.id}&state=queued`);
    const searched = await api('GET', `/files?libraryId=${library.id}&q=c.mkv`);

    expect(page.body.total).toBe(3);
    expect(page.body.items).toHaveLength(2);
    expect(filtered.body.total).toBe(2);
    expect(searched.body.items.map((item: { path: string }) => item.path)).toEqual([
      '/media/c.mkv',
    ]);
  });

  it('rejects a limit above the cap instead of silently truncating the page', async () => {
    const response = await api('GET', '/files?limit=100000');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid-query');
  });

  it('rejects an unknown state rather than matching nothing', async () => {
    const response = await api('GET', '/files?state=converged');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid-query');
  });

  it('requeues a file and the row really changes state', async () => {
    const library = seedLibrary();
    const fileId = seedFile({ libraryId: library.id, path: '/media/a.mkv', state: 'failed' });

    const response = await api('POST', `/files/${fileId}/requeue`);

    expect(response.status).toBe(200);
    expect(createMediaFileRepo(db).getById(fileId)!.state).toBe('queued');
  });

  it('holds a file until a deadline, and refuses a hold with no deadline', async () => {
    const library = seedLibrary();
    const fileId = seedFile({ libraryId: library.id, path: '/media/a.mkv', state: 'queued' });

    const held = await api('POST', `/files/${fileId}/hold`, { hours: 6 });
    const row = createMediaFileRepo(db).getById(fileId)!;

    expect(held.status).toBe(200);
    expect(row.state).toBe('held');
    expect(row.hold_until_ms).toBe(NOW + 6 * 60 * 60 * 1000);

    const deadlineless = await api('POST', `/files/${fileId}/hold`, {});
    expect(deadlineless.status).toBe(400);
  });

  it('returns a file with its run history', async () => {
    const library = seedLibrary();
    const fileId = seedFile({ libraryId: library.id, path: '/media/a.mkv' });
    const jobId = createJobRepo(db).start({
      fileId,
      flowId: 'flow-1',
      flowHash: 'hash-1',
      nowMs: NOW,
    });

    const response = await api('GET', `/files/${fileId}`);

    expect(response.body.file.id).toBe(fileId);
    expect(response.body.jobs.map((job: { id: string }) => job.id)).toEqual([jobId]);
  });
});

describe('flows', () => {
  it('validates a flow and returns one message per problem, without storing it', async () => {
    const response = await api('POST', '/flows/validate', { definition: FLOW_WITH_TWO_PROBLEMS });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.problems).toHaveLength(2);
    expect(createFlowRepo(db).list()).toHaveLength(0);
  });

  it('refuses to STORE a flow it will not run, with the problems in the message', async () => {
    const response = await api('POST', '/flows', {
      name: 'bad',
      definition: FLOW_WITH_TWO_PROBLEMS,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('flow-invalid');
    expect(createFlowRepo(db).list()).toHaveLength(0);
  });

  it('creates, reads and updates a flow, changing its hash', async () => {
    const created = await api('POST', '/flows', { name: 'good', definition: VALID_FLOW });
    expect(created.status).toBe(201);

    const fetched = await api('GET', `/flows/${created.body.id}`);
    expect(fetched.body.definitionHash).toBe(created.body.definitionHash);

    const updated = await api('PUT', `/flows/${created.body.id}`, {
      definition: {
        nodes: [
          { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
          {
            id: 'check',
            pluginId: 'trawlarr:checkVideoCodec',
            pluginVersion: '1.0.0',
            inputs: { codec: 'hevc' },
          },
        ],
        edges: [{ fromNodeId: 'start', toNodeId: 'check', outputNumber: 1 }],
      },
    });

    expect(updated.status).toBe(200);
    expect(createFlowRepo(db).getById(created.body.id)!.definitionHash).not.toBe(
      created.body.definitionHash,
    );
  });

  /**
   * Editing a flow changes what "converged" MEANS for every library using it,
   * and only a scan re-derives that (`scanLibrary`'s rule 7). Without this,
   * a library kept reporting "100% converged" under a flow none of its files
   * had ever been run through, until the periodic rescan came round.
   */
  it('rescans exactly the libraries attached to an edited flow', async () => {
    const created = await api('POST', '/flows', { name: 'good', definition: VALID_FLOW });
    const attached = seedLibrary({ flowId: created.body.id });
    seedLibrary(); // attached to nothing, and must not be walked for this
    scans.requests.length = 0;

    await api('PUT', `/flows/${created.body.id}`, {
      definition: {
        nodes: [
          { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
          {
            id: 'check',
            pluginId: 'trawlarr:checkVideoCodec',
            pluginVersion: '1.0.0',
            inputs: { codec: 'hevc' },
          },
        ],
        edges: [{ fromNodeId: 'start', toNodeId: 'check', outputNumber: 1 }],
      },
    });

    expect(scans.requests).toEqual([{ libraryId: attached.id, reason: 'manual' }]);
  });

  it('lists the built-in templates with the parameters each one exposes', async () => {
    const response = await api('GET', '/flows/templates');

    expect(response.status).toBe(200);
    expect(response.body.map((template: ResponseBody) => template.id)).toContain('transcode-hevc');
    const transcode = response.body.find(
      (template: ResponseBody) => template.id === 'transcode-hevc',
    );
    expect(transcode.parameters.map((parameter: ResponseBody) => parameter.name)).toEqual([
      'targetCodec',
      'encoder',
      'quality',
      'hardwareDecoding',
      'trashRetentionDays',
    ]);
  });

  it('creates a flow from a template', async () => {
    const response = await api('POST', '/flows', {
      name: 'Movies HEVC',
      templateId: 'transcode-hevc',
      templateValues: { encoder: 'hevc_nvenc', quality: '22' },
    });

    expect(response.status).toBe(201);
    // The stored row, not the echo: a template that validated and did not
    // persist would look identical here.
    const stored = await api('GET', `/flows/${response.body.id}`);
    expect(
      stored.body.definition.nodes.find((n: ResponseBody) => n.id === 'encoder').inputs,
      // Hardware decoding is written out explicitly as 'false' rather than
      // omitted: what the node will do is then visible in the stored flow
      // instead of depending on a default the operator cannot see.
    ).toEqual({ encoder: 'hevc_nvenc', quality: '22', hardwareDecoding: 'false' });
    expect(stored.body.definitionHash).toBe(response.body.definitionHash);
  });

  it('refuses an unknown template by name, storing nothing', async () => {
    const response = await api('POST', '/flows', { name: 'x', templateId: 'nope' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('unknown-template');
    expect(createFlowRepo(db).list()).toHaveLength(0);
  });

  it('deleting a flow pauses the library that was using it, with a stated reason', async () => {
    const flow = createFlowRepo(db).create({ name: 'good', definition: VALID_FLOW, nowMs: NOW });
    const library = seedLibrary({ flowId: flow.id });

    const response = await api('DELETE', `/flows/${flow.id}`);

    expect(response.status).toBe(204);
    const after = createLibraryRepo(db).getById(library.id)!;
    expect(after.enabled).toBe(false);
    expect(after.pausedReason).toContain('no flow attached');
  });
});

/** A third-party plugin this host CAN load but cannot vouch for. */
const THIRD_PARTY_PLUGIN_CODE = `
const details = () => ({
  name: 'Mystery Node',
  description: 'fixture',
  style: { borderColor: '#000000' },
  tags: 'test',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'out 1' }],
  requiresVersion: '2.11.01',
});

const plugin = (args) => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});

module.exports = { details, plugin };
`;

const seedProbedFile = async (libraryId: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'trawlarr-api-file-'));
  const path = join(dir, 'sample.mkv');
  await writeFile(path, 'not really a video');
  const fileId = seedFile({ libraryId, path, state: 'queued' });
  db.prepare(`UPDATE media_file SET probe_json = ? WHERE id = ?`).run(
    JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
      format: { duration: '10.0', bit_rate: '1000000' },
    }),
    fileId,
  );
  return fileId;
};

describe('dry run', () => {
  it('walks a vouched-for flow to the end and reports it complete', async () => {
    const flow = createFlowRepo(db).create({ name: 'ok', definition: VALID_FLOW, nowMs: NOW });
    const library = seedLibrary({ flowId: flow.id });
    const fileId = await seedProbedFile(library.id);

    const response = await api('POST', `/flows/${flow.id}/dry-run`, { fileId });

    expect(response.status).toBe(200);
    expect(response.body.complete).toBe(true);
    expect(response.body.stoppedAtNodeId).toBeNull();
    expect(response.body.partialWalkWarning).toBeNull();
    expect(response.body.nodes).toEqual([
      { nodeId: 'start', pluginId: 'trawlarr:start', sideEffects: 'inert' },
    ]);
  });

  it('stops at the first node it cannot vouch for, and never calls that walk complete', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'trawlarr-plugin-'));
    const pluginPath = join(pluginDir, 'index.js');
    await writeFile(pluginPath, THIRD_PARTY_PLUGIN_CODE);

    const flow = createFlowRepo(db).create({
      name: 'third-party',
      definition: {
        nodes: [
          { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
          { id: 'mystery', pluginId: pluginPath, pluginVersion: '1.0.0', inputs: {} },
        ],
        edges: [{ fromNodeId: 'start', toNodeId: 'mystery', outputNumber: 1 }],
      },
      nowMs: NOW,
    });
    const library = seedLibrary({ flowId: flow.id });
    const fileId = await seedProbedFile(library.id);

    const response = await api('POST', `/flows/${flow.id}/dry-run`, { fileId });

    expect(response.status).toBe(200);
    expect(response.body.complete).toBe(false);
    expect(response.body.stoppedAtNodeId).toBe('mystery');
    expect(response.body.stoppedBecause).toContain('cannot vouch for the side effects');
    expect(response.body.partialWalkWarning).toContain('INCOMPLETE');
    expect(
      response.body.nodes.find((node: { nodeId: string }) => node.nodeId === 'mystery').sideEffects,
    ).toBe('unknown');
  });

  it('refuses a dry run against a file that has never been probed, saying which', async () => {
    const flow = createFlowRepo(db).create({ name: 'ok', definition: VALID_FLOW, nowMs: NOW });
    const library = seedLibrary({ flowId: flow.id });
    const fileId = seedFile({ libraryId: library.id, path: '/media/unprobed.mkv' });

    const response = await api('POST', `/flows/${flow.id}/dry-run`, { fileId });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('dry-run-input');
    expect(response.body.error.message).toContain('never been probed');
  });
});

/**
 * A real, loadable CommonJS flow plugin, installed as `fx:myPlugin`. Real
 * because `/flows/validate` resolves an installed id by LOADING the file the
 * registry names and reading its declared outputs.
 */
const FIXTURE_PLUGIN = `
exports.details = () => ({
  name: 'Fixture Plugin',
  description: 'a fixture',
  style: { borderColor: '#fff' },
  tags: 'fixture',
  isStartPlugin: true,
  pType: 'start',
  sidebarPosition: 1,
  icon: '',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'ok' }],
  requiresVersion: '1.0.0',
});
exports.plugin = (args) => ({ outputNumber: 1, outputFileObj: args.inputFileObj, variables: args.variables });
`;

const installFixturePlugin = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'trawlarr-api-plugin-'));
  const dir = join(root, 'p', 'myPlugin', '1.0.0');
  await mkdir(dir, { recursive: true });
  const absPath = join(dir, 'index.js');
  await writeFile(absPath, FIXTURE_PLUGIN, 'utf8');

  const repo = createPluginRepo(db);
  repo.addSource({ id: 'fx', url: root, kind: 'local' });
  repo.replaceSourcePlugins('fx', [
    {
      pluginName: 'myPlugin',
      relPath: join('p', 'myPlugin', '1.0.0', 'index.js'),
      absPath,
      version: '1.0.0',
      details: createPluginLoader().load(absPath).details,
    },
  ]);
  return 'fx:myPlugin';
};

describe('plugins', () => {
  it('lists the installed first-party plugins with what a dry run can promise about each', async () => {
    const response = await api('GET', '/plugins');

    const ids = response.body.map((plugin: { id: string }) => plugin.id);
    expect(ids).toContain('trawlarr:start');
    expect(ids).toContain('trawlarr:execute');
    const execute = response.body.find(
      (plugin: { id: string }) => plugin.id === 'trawlarr:execute',
    );
    expect(execute.sideEffects).toBe('engine-controlled');
  });

  it('returns details for one plugin, and 404 for one nothing can resolve', async () => {
    const found = await api('GET', '/plugins/trawlarr:start');
    const missing = await api('GET', '/plugins/community:doesNotExist');

    expect(found.status).toBe(200);
    expect(found.body.isStartPlugin).toBe(true);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('plugin-not-found');
  });

  it('lists an INSTALLED plugin beside the first-party ones, and stops listing it once uninstalled', async () => {
    const pluginId = await installFixturePlugin();

    const listed = await api('GET', '/plugins');
    const installed = listed.body.find((plugin: { id: string }) => plugin.id === pluginId);
    expect(installed).toBeDefined();
    expect(installed.source).toBe('installed');
    expect(installed.name).toBe('Fixture Plugin');
    // Nothing trawlarr wrote: a dry run must stop at it rather than promise.
    expect(installed.sideEffects).toBe('unknown');

    const one = await api('GET', `/plugins/${pluginId}`);
    expect(one.status).toBe(200);
    expect(one.body.isStartPlugin).toBe(true);

    // The consistent answer to "no longer installed", asked of this call
    // site: it is gone from the list and 404s by id — never a stale row
    // pointing at a path.
    createPluginRepo(db).removeSource('fx');
    const afterRemoval = await api('GET', '/plugins');
    expect(afterRemoval.body.some((plugin: { id: string }) => plugin.id === pluginId)).toBe(false);
    expect((await api('GET', `/plugins/${pluginId}`)).status).toBe(404);
  });

  it('validates a flow that names an installed plugin, and stops once it is uninstalled', async () => {
    const pluginId = await installFixturePlugin();

    const valid = await api('POST', '/flows/validate', { definition: flowUsing(pluginId) });
    expect(valid.status).toBe(200);
    expect(valid.body.ok).toBe(true);
    expect(valid.body.problems).toEqual([]);

    // An output the plugin does NOT declare is still rejected — proof the
    // resolver read the plugin's real details() rather than waving it
    // through as "unknown".
    const badOutput = await api('POST', '/flows/validate', {
      definition: {
        nodes: [
          { id: 'n1', pluginId, pluginVersion: '1.0.0', inputs: {} },
          { id: 'n2', pluginId, pluginVersion: '1.0.0', inputs: {} },
        ],
        edges: [{ fromNodeId: 'n1', toNodeId: 'n2', outputNumber: 7 }],
      },
    });
    expect(badOutput.body.ok).toBe(false);
    expect(JSON.stringify(badOutput.body.problems)).toContain('7');
  });

  it('returns 501, not 404, for a plugin-source route', async () => {
    const response = await api('POST', '/plugins/sources', {});

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe('not-implemented');
  });
});

describe('jobs', () => {
  it('pages job history and returns a job with its step trace', async () => {
    const library = seedLibrary();
    const fileId = seedFile({ libraryId: library.id, path: '/media/a.mkv' });
    const jobRepo = createJobRepo(db);
    const jobId = jobRepo.start({ fileId, flowId: 'f', flowHash: 'h', nowMs: NOW });
    jobRepo.recordStep({
      jobId,
      step: {
        seq: 1,
        nodeId: 'start',
        pluginId: 'trawlarr:start',
        outputNumber: 1,
        durationMs: 3,
        logExcerpt: 'started',
      },
    });

    const list = await api('GET', `/jobs?fileId=${fileId}`);
    const detail = await api('GET', `/jobs/${jobId}`);

    expect(list.body.total).toBe(1);
    expect(detail.body.job.id).toBe(jobId);
    expect(detail.body.steps).toHaveLength(1);
    expect(detail.body.steps[0].pluginId).toBe('trawlarr:start');
  });

  it('cancels a running job through the supervisor', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    supervisor.running.add('job-1');
    server = createApiServer(
      createApiContext({
        db,
        settings,
        bus: createEventBus(),
        supervisor,
        scans,
        nowMs: () => NOW,
        version: '0.0.0-test',
      }),
      { onError: () => {} },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await api('POST', '/jobs/job-1/cancel');

    expect(response.status).toBe(202);
    expect(supervisor.cancelled).toEqual(['job-1']);
  });

  it('returns 404 for cancelling a job that is not running, rather than pretending', async () => {
    const response = await api('POST', '/jobs/nope/cancel');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('job-not-running');
    expect(supervisor.cancelled).toEqual([]);
  });

  it('returns 404 for a job that does not exist', async () => {
    const response = await api('GET', '/jobs/anything/log');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('job-not-found');
  });

  it('returns 404, named, for a job that predates per-job logs', async () => {
    const library = seedLibrary();
    const fileId = seedFile({ libraryId: library.id, path: '/media/nolog.mkv' });
    const jobId = createJobRepo(db).start({ fileId, flowId: 'f', flowHash: 'h', nowMs: NOW });

    const response = await api('GET', `/jobs/${jobId}/log`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('job-log-absent');
  });

  it('serves the bytes actually on disk for a job with a log file', async () => {
    const library = seedLibrary();
    const fileId = seedFile({ libraryId: library.id, path: '/media/haslog.mkv' });
    const logPath = join(await mkdtemp(join(tmpdir(), 'trawlarr-joblog-api-')), 'job.log');
    await writeFile(logPath, 'line one\nline two\n');
    const jobId = createJobRepo(db).start({
      fileId,
      flowId: 'f',
      flowHash: 'h',
      nowMs: NOW,
      logPath,
    });

    const response = await api('GET', `/jobs/${jobId}/log`);

    expect(response.status).toBe(200);
    expect(response.body.jobId).toBe(jobId);
    expect(response.body.path).toBe(logPath);
    expect(response.body.text).toBe('line one\nline two\n');
  });

  it('returns 410, named, for a job whose log has been swept off disk', async () => {
    const library = seedLibrary();
    const fileId = seedFile({ libraryId: library.id, path: '/media/expiredlog.mkv' });
    const logPath = join(await mkdtemp(join(tmpdir(), 'trawlarr-joblog-api-')), 'gone.log');
    const jobId = createJobRepo(db).start({
      fileId,
      flowId: 'f',
      flowHash: 'h',
      nowMs: NOW,
      logPath,
    });

    const response = await api('GET', `/jobs/${jobId}/log`);

    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('job-log-expired');
  });
});

describe('nodes and workers', () => {
  it('reports the local node with its hardware and access mode', async () => {
    const { body } = await api('GET', '/nodes');

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'local', accessMode: 'direct', hardwareTypes: ['cpu'] });
  });

  it('writes a node row when the context is built, so job.node_id can mean something', () => {
    const row = db.prepare(`SELECT * FROM node WHERE id = 'local'`).get() as
      { last_seen_at: number } | undefined;

    expect(row?.last_seen_at).toBe(NOW);
  });

  it('sets base worker counts in the schedule and ticks the supervisor', async () => {
    const before = supervisor.ticks;

    const response = await api('PUT', '/workers/counts', { transcode: 3 });

    expect(response.status).toBe(200);
    // The SCHEDULE is the source of truth, so that is what must have changed.
    expect(settings.getSchedule().baseCounts.transcode).toBe(3);
    expect(supervisor.ticks).toBeGreaterThan(before);
  });

  it('rejects a count for a worker class that does not exist', async () => {
    const response = await api('PUT', '/workers/counts', { gpu: 3 });

    expect(response.status).toBe(400);
    expect(settings.getSchedule().baseCounts.transcode).toBe(1);
  });

  it('pauses and resumes the pool', async () => {
    const paused = await api('POST', '/workers/pause');
    expect(paused.body.paused).toBe(true);
    expect(supervisor.status().paused).toBe(true);

    const resumed = await api('POST', '/workers/resume');
    expect(resumed.body.paused).toBe(false);
    expect(supervisor.status().paused).toBe(false);
  });
});

describe('system', () => {
  it('reports version with a null contract level and a note saying why', async () => {
    const { body } = await api('GET', '/system/version');

    expect(body.contractLevel).toBeNull();
    expect(body.note).toContain('2.10');
    expect(body.binaries.ffmpeg).toEqual({ path: 'ffmpeg', resolved: true });
    expect(body.binaries.ffprobe).toEqual({ path: 'ffprobe', resolved: false });
  });

  it('reports no hardware findings when the preflight found nothing to report', async () => {
    // Empty, not absent: a client checking a deployment reads this array, and
    // a missing key would read the same as "nothing wrong" on a build that
    // never checked at all.
    const { body } = await api('GET', '/system/version');

    expect(body.hardware).toEqual([]);
  });

  it('reports what the hardware preflight found, verbatim', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createApiServer(
      createApiContext({
        db,
        settings,
        bus: createEventBus(),
        supervisor,
        scans,
        nowMs: () => NOW,
        version: '0.0.0-test',
        hardwareFindings: [
          { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
        ],
      }),
      { onError: () => {} },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const { status, body } = await api('GET', '/system/version');

    expect(status).toBe(200);
    expect(body.hardware).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
    ]);
    // The declaration itself is untouched by the finding — reporting is not
    // correcting.
    expect((await api('GET', '/system/settings')).body.hardware.available).toEqual(['cpu']);
  });

  it('patches a settings group and the stored value really changes', async () => {
    const response = await api('PATCH', '/system/settings', {
      binaries: { ffmpeg: '/opt/ffmpeg' },
      scan: { settleMs: 1000 },
    });

    expect(response.status).toBe(200);
    expect(createSettingsRepo({ db }).getBinaries().ffmpeg).toBe('/opt/ffmpeg');
    expect(createSettingsRepo({ db }).getScan().settleMs).toBe(1000);
  });

  it('rejects an invalid setting with the repository message, and stores nothing', async () => {
    const response = await api('PATCH', '/system/settings', { daemon: { port: 'eleven' } });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid-setting');
    expect(createSettingsRepo({ db }).getDaemon().port).toBe(8265);
  });

  it('reads and writes the schedule', async () => {
    const response = await api('PUT', '/system/schedule', {
      timezone: 'UTC',
      baseCounts: { transcode: 2, health: 0 },
      windows: [],
    });

    expect(response.status).toBe(200);
    expect(settings.getSchedule().baseCounts.transcode).toBe(2);
    expect((await api('GET', '/system/schedule')).body.baseCounts.transcode).toBe(2);
  });

  it('reports an environment variable that did not win', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createApiServer(
      createApiContext({
        db,
        settings,
        bus: createEventBus(),
        supervisor,
        scans,
        nowMs: () => NOW,
        version: '0.0.0-test',
        envApplications: [
          {
            name: 'NUMBER_OF_WORKERS',
            target: 'schedule.baseCounts.transcode',
            envValue: '6',
            applied: 'ignored-already-set',
            problem: null,
          },
        ],
      }),
      { onError: () => {} },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await api('GET', '/system/settings');

    expect(response.status).toBe(200);
    expect(response.body.environment).toEqual([
      {
        name: 'NUMBER_OF_WORKERS',
        target: 'schedule.baseCounts.transcode',
        envValue: '6',
        applied: 'ignored-already-set',
        problem: null,
        currentValue: '1',
        matchesEnv: false,
      },
    ]);
  });
});

describe('maintenance, sharing the operations the CLI runs', () => {
  it('reaps a row stranded in running, and the row really leaves running', async () => {
    const library = seedLibrary();
    const fileId = seedFile({
      libraryId: library.id,
      path: '/media/stalled.mkv',
      state: 'running',
      // Two days without a sign of life.
      updatedAt: NOW - 48 * 60 * 60 * 1000,
    });

    const response = await api('POST', '/system/maintenance/reap', {});

    expect(response.status).toBe(200);
    expect(response.body.reclaimed).toBe(1);
    expect(createMediaFileRepo(db).getById(fileId)!.state).not.toBe('running');
  });

  it('leaves a live running row alone under dry-run, and changes nothing', async () => {
    const library = seedLibrary();
    const fileId = seedFile({
      libraryId: library.id,
      path: '/media/live.mkv',
      state: 'running',
      updatedAt: NOW - 48 * 60 * 60 * 1000,
    });

    const response = await api('POST', '/system/maintenance/reap', { dryRun: true });

    expect(response.body.reclaimed).toBe(1);
    expect(createMediaFileRepo(db).getById(fileId)!.state).toBe('running');
  });

  it('forgets a row whose file is gone, and the row is really deleted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trawlarr-api-'));
    const library = seedLibrary({ roots: [dir] });
    const fileId = seedFile({
      libraryId: library.id,
      path: join(dir, 'gone.mkv'),
      state: 'queued',
      missingSinceMs: NOW - 1000,
    });

    const response = await api('POST', '/system/maintenance/forget', {
      libraryId: library.id,
      missing: true,
    });

    expect(response.status).toBe(200);
    expect(response.body.results[0].summary.forgotten).toBe(1);
    expect(createMediaFileRepo(db).getById(fileId)).toBeNull();
  });

  it('refuses a forget that names nothing, rather than sweeping every library', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trawlarr-api-'));
    const library = seedLibrary({ roots: [dir] });
    const fileId = seedFile({
      libraryId: library.id,
      path: join(dir, 'gone.mkv'),
      missingSinceMs: NOW - 1000,
    });

    const response = await api('POST', '/system/maintenance/forget', {});

    expect(response.status).toBe(400);
    expect(createMediaFileRepo(db).getById(fileId)).not.toBeNull();
  });

  it('purges trash older than the retention the library flow declares, and the file really goes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trawlarr-api-'));
    const trashDir = join(root, '.trawlarr', 'trash');
    await mkdir(trashDir, { recursive: true });
    // The trash entry NAME carries the moment it was trashed: 30 days ago.
    const trashedAt = NOW - 30 * 24 * 60 * 60 * 1000;
    await writeFile(join(trashDir, `old.${trashedAt}.mkv`), 'x');
    const library = seedLibrary({ roots: [root] });

    const response = await api('POST', '/system/maintenance/trash-purge', {
      libraryId: library.id,
    });

    expect(response.status).toBe(200);
    expect(response.body.sweeps[0].summary.removed).toBe(1);
    expect(await readdir(trashDir)).toEqual([]);
  });
});

/**
 * The bundle is served by the SAME server on the SAME port as the API, so
 * there is one thing to publish and one origin — which is what lets the UI
 * send its key as a header with no cross-origin machinery at all. These run
 * against a real `http.Server` over a real socket, because the whole risk
 * here is ordering inside `createApiHandler`, and a handler called directly
 * cannot demonstrate that ordering.
 */
describe('the web bundle, on the daemon’s own port', () => {
  let webServer: Server;
  let webBase: string;

  /**
   * A bundle containing a file at `api/v1/system/health` — the exact shape
   * that would shadow the REST surface if the API-prefix check in
   * `static-files.ts` were removed.
   */
  const bundleWithApiShapedFile = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'trawlarr-bundle-'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>trawlarr</title>');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'app-abc123.js'), 'console.log("trawlarr")');
    await mkdir(join(root, 'api', 'v1', 'system'), { recursive: true });
    await writeFile(join(root, 'api', 'v1', 'system', 'health'), 'SHADOWED');
    return root;
  };

  const startWith = async (webRoot: string | null): Promise<void> => {
    const ctx = createApiContext({
      db,
      settings,
      bus: createEventBus(),
      supervisor,
      scans,
      nowMs: () => NOW,
      version: '0.0.0-test',
    });
    webServer = createApiServer(ctx, { onError: () => {}, webRoot });
    await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
    webBase = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
  };

  afterEach(async () => {
    await new Promise<void>((resolve) => webServer.close(() => resolve()));
  });

  it('routes /api/v1 to the API even with a bundle that would shadow it', async () => {
    await startWith(await bundleWithApiShapedFile());

    const health = await fetch(`${webBase}/api/v1/system/health`);
    const body = (await health.json()) as { status: string };

    expect(health.status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('serves index.html for a client-side route, over the same port', async () => {
    await startWith(await bundleWithApiShapedFile());

    const page = await fetch(`${webBase}/libraries/abc`);
    const text = await page.text();

    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(text).toContain('<!doctype html>');
  });

  it('serves the hashed asset bytes verbatim, with a JavaScript content type', async () => {
    await startWith(await bundleWithApiShapedFile());

    const asset = await fetch(`${webBase}/assets/app-abc123.js`);

    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toBe('console.log("trawlarr")');
  });

  it('serves the bundle without an API key, and still refuses the API without one', async () => {
    await startWith(await bundleWithApiShapedFile());

    // The bundle is public bytes; the KEY is what guards the data, and the
    // bundle has none in it. An operator who could not load the page could
    // never paste a key into it.
    const page = await fetch(`${webBase}/`);
    const libraries = await fetch(`${webBase}/api/v1/libraries`);

    expect(page.status).toBe(200);
    expect(libraries.status).toBe(401);
  });

  it('never reads outside the bundle, even through a symlink inside it', async () => {
    const root = await bundleWithApiShapedFile();
    const secret = join(root, '..', `secret-${randomUUID()}.txt`);
    await writeFile(secret, 'the-daemon-api-key');
    await symlink(secret, join(root, 'escape.txt'));
    await startWith(root);

    const traversal = await fetch(`${webBase}/%2e%2e/${secret.split('/').pop()!}`);
    const viaSymlink = await fetch(`${webBase}/escape.txt`);

    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain('the-daemon-api-key');
    expect(viaSymlink.status).toBe(404);
    expect(await viaSymlink.text()).not.toContain('the-daemon-api-key');
  });

  it('explains itself instead of 404ing when no bundle was built', async () => {
    await startWith(null);

    const page = await fetch(`${webBase}/`);
    const body = (await page.json()) as { error: { code: string } };
    const health = await fetch(`${webBase}/api/v1/system/health`);

    expect(page.status).toBe(503);
    expect(body.error.code).toBe('web-ui-not-built');
    // The point of the 503: the API is unaffected.
    expect(health.status).toBe(200);
  });
});
