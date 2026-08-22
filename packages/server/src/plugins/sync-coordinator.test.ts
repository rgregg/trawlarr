import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEventBus, type TrawlarrEvent } from '../daemon/events.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { PluginSourceError } from './fetch-source.js';
import { createPluginSyncCoordinator } from './sync-coordinator.js';
import type { SyncReport } from './sync-source.js';

const NOW = 1_700_000_000_000;

/**
 * A coordinator over a real database and a real bus, with the SYNCER as the
 * only double — the unit under test is the run bookkeeping, and a real sync
 * would make every assertion here about the filesystem instead.
 */
const harness = (syncFn: (sourceId: string) => Promise<SyncReport>) => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  const bus = createEventBus();
  const events: TrawlarrEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const coordinator = createPluginSyncCoordinator({
    db,
    bus,
    dataDir: mkdtempSync(join(tmpdir(), 'trawlarr-sync-coord-')),
    nowMs: () => NOW,
    syncFn: async (input) => await syncFn(input.sourceId),
  });
  return { coordinator, events, db };
};

const report = (installed: number): SyncReport => ({ sourceId: 'fx', installed, skipped: [] });

describe('plugin sync coordinator', () => {
  it('reports a source it has never synced as never run, rather than as idle-and-finished', () => {
    const { coordinator } = harness(async () => await Promise.resolve(report(0)));

    expect(coordinator.status('fx')).toEqual({
      sourceId: 'fx',
      runId: null,
      running: false,
      startedAtMs: null,
      finishedAtMs: null,
      report: null,
      error: null,
    });
  });

  it('records the run, its report and its events, and answers idle only once it is over', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { coordinator, events } = harness(async () => {
      await held;
      return report(3);
    });

    const request = coordinator.request('fx');
    expect(request).toEqual({ started: true, runId: 1 });
    expect(coordinator.syncing()).toEqual(['fx']);
    expect(coordinator.status('fx')).toMatchObject({ runId: 1, running: true, report: null });

    release();
    await coordinator.idle();

    expect(coordinator.syncing()).toEqual([]);
    expect(coordinator.status('fx')).toMatchObject({
      runId: 1,
      running: false,
      finishedAtMs: NOW,
      report: { installed: 3 },
      error: null,
    });
    expect(events).toEqual([
      { type: 'plugin.sync.started', sourceId: 'fx', runId: 1 },
      { type: 'plugin.sync.finished', sourceId: 'fx', runId: 1, installed: 3, skipped: 0 },
    ]);
  });

  it('starts nothing for a second request while one is in flight, and everything for a different source', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { coordinator } = harness(async () => {
      await held;
      return report(1);
    });

    const first = coordinator.request('fx');
    const again = coordinator.request('fx');
    const other = coordinator.request('other');

    expect(again).toEqual({ started: false, runId: first.runId });
    expect(other.started).toBe(true);
    expect(other.runId).not.toBe(first.runId);
    expect(coordinator.syncing().sort()).toEqual(['fx', 'other']);

    release();
    await coordinator.idle();
    expect(coordinator.syncing()).toEqual([]);
  });

  it('keeps a failure as state, with the source error-s own code, rather than rejecting', async () => {
    const { coordinator, events } = harness(() =>
      Promise.reject(new PluginSourceError('unreachable', 'nothing answered')),
    );

    coordinator.request('fx');
    await coordinator.idle();

    // Nothing awaits the promise a request starts, so a rejection would be an
    // UNHANDLED one and would take the daemon down with every transcode it
    // is supervising. The failure has to be readable instead.
    expect(coordinator.status('fx')).toMatchObject({
      runId: 1,
      running: false,
      report: null,
      error: { code: 'source-unreachable', message: 'nothing answered' },
    });
    expect(events).toContainEqual({
      type: 'plugin.sync.failed',
      sourceId: 'fx',
      runId: 1,
      code: 'source-unreachable',
      message: 'nothing answered',
    });
  });

  it('classifies a failure that is not a source error as unclassified, not as a source problem', async () => {
    const { coordinator } = harness(() => Promise.reject(new Error('sqlite is unhappy')));

    coordinator.request('fx');
    await coordinator.idle();

    expect(coordinator.status('fx').error).toEqual({
      code: 'sync-failed',
      message: 'sqlite is unhappy',
    });
  });
});
