import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo, type FlowRecord } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import type { FlowDryRunResult, dryRunFlow } from './dry-run.js';
import { createFlowDryRunCoordinator, type FlowDryRunCoordinator } from './dry-run-runs.js';

const NOW = 1_700_000_000_000;

const DEF: FlowDefinition = {
  nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
};

/**
 * The editor's canvas: a distinct object, so a fake can tell the canvas half
 * (called with this) from the published half (called with the stored flow's
 * definition snapshot) by identity.
 */
const CANVAS: FlowDefinition = {
  nodes: [{ id: 'canvas-start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
};

const fakeResult = (over: Partial<FlowDryRunResult>): FlowDryRunResult =>
  ({
    complete: true,
    stoppedAtNodeId: null,
    stopReason: 'end-of-flow',
    failed: false,
    error: null,
    reviewReason: null,
    wouldRunFfmpeg: false,
    executeDecisions: [],
    steps: [],
    plannedCommands: [],
    ...over,
  }) as FlowDryRunResult;

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

type DryRun = typeof dryRunFlow;

let db: Db;
let flow: FlowRecord;
let libraryId: string;

const seedFile = (input: {
  libraryId: string;
  path: string;
  missingSinceMs?: number | null;
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
    'queued',
    input.missingSinceMs ?? null,
    NOW,
    NOW,
  );
  return id;
};

const coordinator = (dryRun: DryRun): FlowDryRunCoordinator =>
  createFlowDryRunCoordinator({
    db,
    binaries: () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
    nowMs: () => NOW,
    dryRun,
  });

const start = (runs: FlowDryRunCoordinator) =>
  runs.start({ flowId: flow.id, definition: CANVAS, definitionHash: 'canvas-hash' });

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  flow = createFlowRepo(db).create({ name: 'Flow', definition: DEF, nowMs: NOW });
  libraryId = createLibraryRepo(db).create({
    name: 'lib',
    roots: ['/media/lib'],
    flowId: flow.id,
    nowMs: NOW,
  }).id;
});

describe('createFlowDryRunCoordinator', () => {
  const holdB: DryRun = (input) => {
    const path = db.prepare('SELECT path FROM media_file WHERE id = ?').get(input.fileId) as {
      path: string;
    };
    if (input.definition === CANVAS && path.path.endsWith('b.mkv')) {
      return Promise.resolve(
        fakeResult({ stopReason: 'held-for-review', complete: false, reviewReason: 'Short.' }),
      );
    }
    return Promise.resolve(fakeResult({}));
  };

  it('groups changes against published', async () => {
    seedFile({ libraryId, path: '/a.mkv' });
    const bId = seedFile({ libraryId, path: '/b.mkv' });
    seedFile({ libraryId, path: '/c.mkv' });
    const runs = coordinator(holdB);
    const { runId } = start(runs);

    await until(() => runs.get(flow.id, runId)?.status === 'done');
    const view = runs.get(flow.id, runId)!;
    expect(view.processed).toBe(3);
    expect(view.total).toBe(3);
    expect(view.error).toBeNull();
    expect(view.definitionHash).toBe('canvas-hash');
    expect(view.publishedHash).toBe(flow.definitionHash);
    expect(view.counts).toEqual({ 'no-change': 2, 'hold:Short.': 1 });
    expect(view.changes).toEqual([
      {
        from: { kind: 'no-change' },
        to: { kind: 'hold', detail: 'Short.' },
        files: [{ fileId: bId, path: '/b.mkv' }],
      },
    ]);
  });

  it('ignores missing files and other flows’ libraries', async () => {
    seedFile({ libraryId, path: '/a.mkv' });
    seedFile({ libraryId, path: '/gone.mkv', missingSinceMs: NOW });
    const other = createFlowRepo(db).create({ name: 'Other', definition: DEF, nowMs: NOW });
    const otherLibrary = createLibraryRepo(db).create({
      name: 'other',
      roots: ['/media/other'],
      flowId: other.id,
      nowMs: NOW,
    });
    seedFile({ libraryId: otherLibrary.id, path: '/media/other/x.mkv' });
    const runs = coordinator(holdB);
    const { runId } = start(runs);

    await until(() => runs.get(flow.id, runId)?.status === 'done');
    expect(runs.get(flow.id, runId)!.total).toBe(1);
    expect(runs.get(flow.id, runId)!.files.map((row) => row.path)).toEqual(['/a.mkv']);
  });

  it('throws for an unknown flow', () => {
    const runs = coordinator(holdB);
    expect(() =>
      runs.start({ flowId: 'nope', definition: DEF, definitionHash: 'canvas-hash' }),
    ).toThrow(/Unknown flow/);
  });

  it('a file that cannot be dry-run is a failure, not a crashed run', async () => {
    seedFile({ libraryId, path: '/a.mkv' });
    const bId = seedFile({ libraryId, path: '/b.mkv' });
    const runs = coordinator((input) =>
      input.fileId === bId
        ? Promise.reject(new Error('never probed'))
        : Promise.resolve(fakeResult({})),
    );
    const { runId } = start(runs);

    await until(() => runs.get(flow.id, runId)?.status === 'done');
    const view = runs.get(flow.id, runId)!;
    const row = view.files.find((file) => file.fileId === bId)!;
    expect(row.outcome).toEqual({ kind: 'fail', detail: 'never probed' });
    expect(row.publishedOutcome).toEqual({ kind: 'fail', detail: 'never probed' });
    expect(view.counts).toEqual({ 'no-change': 1, fail: 1 });
    expect(runs.file(flow.id, runId, bId)).toEqual({
      fileId: bId,
      path: '/b.mkv',
      canvas: null,
      published: null,
    });
  });

  it('starting again cancels the first run', async () => {
    seedFile({ libraryId, path: '/a.mkv' });
    seedFile({ libraryId, path: '/b.mkv' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runs = coordinator(async () => {
      calls += 1;
      await gate;
      return fakeResult({});
    });
    const first = start(runs);
    await until(() => calls > 0);
    const second = start(runs);
    release();

    expect(runs.get(flow.id, first.runId)).toBeNull();
    await until(() => runs.get(flow.id, second.runId)?.status === 'done');
    expect(runs.get(flow.id, second.runId)!.processed).toBe(2);
  });

  it('cancel stops the walk', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) seedFile({ libraryId, path: `/${name}.mkv` });
    const runs = coordinator(
      () => new Promise((resolve) => setTimeout(() => resolve(fakeResult({})), 5)),
    );
    const { runId } = start(runs);

    await until(() => runs.get(flow.id, runId)!.processed > 0);
    expect(runs.cancel(flow.id, runId)).toBe(true);
    await until(() => runs.get(flow.id, runId)!.status === 'cancelled');
    expect(runs.get(flow.id, runId)!.processed).toBeLessThan(5);
    expect(runs.cancel(flow.id, 'another-run')).toBe(false);
  });

  it('stopAll resolves once walking ends', async () => {
    for (const name of ['a', 'b', 'c']) seedFile({ libraryId, path: `/${name}.mkv` });
    let inFlight = 0;
    const runs = coordinator(async () => {
      inFlight += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return fakeResult({});
    });
    const { runId } = start(runs);
    await until(() => inFlight > 0);

    await runs.stopAll();
    expect(inFlight).toBe(0);
    expect(runs.get(flow.id, runId)!.status).toBe('cancelled');
  });

  it('compares against the definition published when the run started', async () => {
    seedFile({ libraryId, path: '/a.mkv' });
    seedFile({ libraryId, path: '/b.mkv' });
    const republished: FlowDefinition = {
      nodes: [
        { id: 'newer-start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
      ],
      edges: [],
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Array<FlowDefinition | undefined> = [];
    const runs = coordinator(async (input) => {
      calls.push(input.definition);
      await gate;
      return fakeResult({});
    });
    const { runId } = runs.start({ flowId: flow.id, definition: CANVAS, definitionHash: 'c' });
    await until(() => calls.length > 0);
    createFlowRepo(db).update({ id: flow.id, definition: republished, nowMs: NOW + 1 });
    release();

    await until(() => runs.get(flow.id, runId)?.status === 'done');
    expect(runs.get(flow.id, runId)!.publishedHash).toBe(flow.definitionHash);
    const publishedCalls = calls.filter((definition) => definition !== CANVAS);
    expect(publishedCalls).toHaveLength(2);
    for (const definition of publishedCalls) expect(definition).toEqual(DEF);
  });

  it('a cancel during the canvas half skips the published half and records nothing', async () => {
    seedFile({ libraryId, path: '/a.mkv' });
    seedFile({ libraryId, path: '/b.mkv' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Array<FlowDefinition | undefined> = [];
    const runs = coordinator(async (input) => {
      calls.push(input.definition);
      await gate;
      return fakeResult({});
    });
    const { runId } = runs.start({ flowId: flow.id, definition: CANVAS, definitionHash: 'c' });
    await until(() => calls.length > 0);
    expect(runs.cancel(flow.id, runId)).toBe(true);
    release();
    await runs.stopAll();

    expect(calls).toEqual([CANVAS]);
    const view = runs.get(flow.id, runId)!;
    expect(view.status).toBe('cancelled');
    expect(view.processed).toBe(0);
    expect(view.files).toEqual([]);
  });

  it('file() returns both walks', async () => {
    seedFile({ libraryId, path: '/a.mkv' });
    const bId = seedFile({ libraryId, path: '/b.mkv' });
    const runs = coordinator(holdB);
    const { runId } = start(runs);

    await until(() => runs.get(flow.id, runId)?.status === 'done');
    const detail = runs.file(flow.id, runId, bId)!;
    expect(detail.path).toBe('/b.mkv');
    expect(detail.canvas!.reviewReason).toBe('Short.');
    expect(detail.published!.stopReason).toBe('end-of-flow');
    expect(runs.file(flow.id, runId, 'unknown')).toBeNull();
    expect(runs.file(flow.id, 'other-run', bId)).toBeNull();
  });
});
