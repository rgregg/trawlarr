import { join } from 'node:path';
import type { Db } from '../db/connection.js';
import type { EventBus } from '../daemon/events.js';
import { PluginSourceError } from './fetch-source.js';
import { createPluginRepo } from './plugin-repo.js';
import { syncSource, type SyncReport } from './sync-source.js';

/** Why the last run of a source's sync failed. `code` is what a client branches on. */
export interface PluginSyncFailure {
  code: string;
  message: string;
}

/**
 * Everything a caller can learn about a source's syncing WITHOUT having held
 * a connection open for it.
 *
 * `runId` is the whole point of the shape: a caller that asked for a sync is
 * told which run it started, and polls until THAT run is no longer running.
 * Without it, a poll that arrives after a fast sync has finished and a poll
 * that arrives before a slow one has started look identical, and a client
 * either reports the previous run's result or waits for ever.
 */
export interface PluginSyncStatus {
  sourceId: string;
  /** The most recent run of this source, or null if it has never been asked to sync. */
  runId: number | null;
  running: boolean;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  /** The last run's report, present only when that run SUCCEEDED. */
  report: SyncReport | null;
  /** The last run's failure, present only when that run FAILED. */
  error: PluginSyncFailure | null;
}

export interface PluginSyncRequest {
  /** False when a sync of this source was already in flight; nothing new was started. */
  started: boolean;
  /** The run the caller should watch: the one just started, or the one already running. */
  runId: number;
}

export interface PluginSyncCoordinator {
  /** Start a sync unless one is already running for this source. Never throws. */
  request(sourceId: string): PluginSyncRequest;
  status(sourceId: string): PluginSyncStatus;
  syncing(): string[];
  /** Resolves when no sync is in flight. Used by shutdown, and by tests. */
  idle(): Promise<void>;
}

export interface CreatePluginSyncCoordinatorInput {
  db: Db;
  bus: EventBus;
  /** The data directory; extractions live in `<dataDir>/plugins`. */
  dataDir: string;
  nowMs: () => number;
  /** Seam for tests. Production always uses `syncSource`. */
  syncFn?: typeof syncSource;
  /**
   * Seam for tests, at the NETWORK boundary only — the same one
   * `fetch-source`'s own suite uses. It replaces where the bytes come from
   * and nothing else: the https rule, the archive checks and the size bounds
   * still run, which is what lets a test prove a hostile archive is refused
   * through the real routes rather than through a stubbed syncer.
   */
  fetchFn?: typeof fetch;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * One turn of the event loop, between plugins.
 *
 * The daemon is serving the UI and supervising workers while a sync validates
 * ninety modules; without this the whole validation pass is one uninterrupted
 * synchronous block and every other request waits behind it.
 */
const nextTurn = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * Syncing a plugin source, INSIDE the daemon, without holding the request.
 *
 * A sync fetches a tarball over the network, unpacks it, and loads every
 * candidate plugin to validate it. Against Tdarr's repository that is
 * minutes and ninety-one module loads. The daemon is the only process
 * allowed to write the database, so the sync has to happen here — but an
 * HTTP handler that awaited it would hold a connection open past every
 * reverse proxy's timeout, and would make "install a plugin" a request that
 * routinely fails while the work it asked for succeeds.
 *
 * So this follows the SCAN COORDINATOR's contract exactly, because the
 * problem is the same one: `POST /plugins/sources/:id/sync` answers 202, the
 * work continues here, and the outcome is readable afterwards from
 * `GET /plugins/sources/:id` and pushed as `plugin.sync.*` on the websocket.
 * Nothing is obtainable only from the event stream — a client that was not
 * listening polls and learns the same thing, which is the rule the whole
 * event channel is built on.
 *
 * ONE RUN PER SOURCE. A second request while one is in flight starts
 * nothing: two syncs of one source would race on the same extraction slot
 * and on `replaceSourcePlugins`, and the loser would leave the source's
 * installed set describing a tree that had already been pruned. Two
 * DIFFERENT sources may sync at once — they touch different rows and
 * different slots.
 *
 * A FAILURE IS STATE, NOT A THROW. Nothing is awaiting the promise this
 * starts, so a rejection would be an unhandled one and would take the daemon
 * down with every transcode it supervises. Every failure is caught, recorded
 * against the run, and emitted; the caller reads it from the status.
 */
export const createPluginSyncCoordinator = (
  input: CreatePluginSyncCoordinatorInput,
): PluginSyncCoordinator => {
  const run = input.syncFn ?? syncSource;
  const statuses = new Map<string, PluginSyncStatus>();
  const inFlight = new Map<string, Promise<void>>();
  let nextRunId = 1;

  const blank = (sourceId: string): PluginSyncStatus => ({
    sourceId,
    runId: null,
    running: false,
    startedAtMs: null,
    finishedAtMs: null,
    report: null,
    error: null,
  });

  const failureOf = (error: unknown): PluginSyncFailure => {
    // A `PluginSourceError` already carries the distinction a client needs —
    // an insecure url, an unreachable host and a refused archive are three
    // different things to do about it — so it is passed through rather than
    // flattened. Anything else is genuinely unclassified.
    if (error instanceof PluginSourceError) {
      // Prefixed exactly as the routes prefix it, so the code a caller sees
      // in this status is the code it would have seen had the failure been
      // synchronous.
      return { code: `source-${error.code}`, message: error.message };
    }
    return { code: 'sync-failed', message: messageOf(error) };
  };

  const start = (sourceId: string, runId: number): Promise<void> => {
    const startedAtMs = input.nowMs();
    statuses.set(sourceId, {
      sourceId,
      runId,
      running: true,
      startedAtMs,
      finishedAtMs: null,
      report: null,
      error: null,
    });
    input.bus.emit({ type: 'plugin.sync.started', sourceId, runId });

    const settle = (over: Partial<PluginSyncStatus>): void => {
      statuses.set(sourceId, {
        ...blank(sourceId),
        runId,
        startedAtMs,
        finishedAtMs: input.nowMs(),
        ...over,
      });
    };

    return (async (): Promise<void> => {
      try {
        const report = await run({
          repo: createPluginRepo(input.db),
          sourceId,
          // A tarball source's extracted tree IS the installed plugin, so it
          // lives permanently under the data directory — the same directory
          // the CLI uses, so a source synced by either is the same install.
          cacheDir: join(input.dataDir, 'plugins'),
          nowMs: input.nowMs,
          yieldFn: nextTurn,
          fetchFn: input.fetchFn,
        });
        settle({ report });
        input.bus.emit({
          type: 'plugin.sync.finished',
          sourceId,
          runId,
          installed: report.installed,
          skipped: report.skipped.length,
        });
      } catch (error) {
        const failure = failureOf(error);
        settle({ error: failure });
        input.bus.emit({
          type: 'plugin.sync.failed',
          sourceId,
          runId,
          code: failure.code,
          message: failure.message,
        });
      } finally {
        inFlight.delete(sourceId);
      }
    })();
  };

  return {
    request(sourceId) {
      const running = inFlight.get(sourceId);
      if (running !== undefined) {
        return { started: false, runId: statuses.get(sourceId)?.runId ?? 0 };
      }
      const runId = nextRunId;
      nextRunId += 1;
      inFlight.set(sourceId, start(sourceId, runId));
      return { started: true, runId };
    },

    status: (sourceId) => statuses.get(sourceId) ?? blank(sourceId),

    syncing: () => [...inFlight.keys()],

    idle: async () => {
      // Re-read after each settle: a sync that finished may have been the one
      // holding the map, and another may have been requested meanwhile.
      while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
    },
  };
};
