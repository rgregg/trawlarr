import { randomUUID } from 'node:crypto';
import type { FlowDefinition } from '@trawlarr/core';
import type { Db } from '../db/connection.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { dryRunFlow, DryRunInputError, type FlowDryRunResult } from './dry-run.js';
import { classifyDryRun, outcomeKey, type DryRunOutcome } from './dry-run-outcome.js';

/**
 * Library dry runs from the flow editor: every file of a flow's libraries,
 * walked once against the canvas definition and once against the published
 * one, so the editor can say which files a draft would treat differently.
 *
 * Held IN MEMORY, never in the database: a preview is out of date the moment
 * the flow is edited again, so there is nothing worth surviving a restart, and
 * a dry run must never write to the database it is previewing.
 *
 * ONE RUN PER FLOW: a second start is always a newer question about the same
 * flow, so it cancels and replaces the first rather than queueing behind it.
 *
 * The walk YIELDS before every file: it shares the daemon's event loop with
 * the API and the worker supervisor, and a synchronous stretch over thousands
 * of files would stall heartbeats and requests for the whole library.
 */

export type DryRunStatus = 'running' | 'done' | 'cancelled' | 'failed';

export interface DryRunChangeGroup {
  from: DryRunOutcome;
  to: DryRunOutcome;
  files: Array<{ fileId: string; path: string }>;
}

export interface DryRunRunView {
  runId: string;
  flowId: string;
  status: DryRunStatus;
  error: string | null;
  processed: number;
  total: number;
  definitionHash: string;
  publishedHash: string;
  /** Count per outcomeKey, for the canvas definition. */
  counts: Record<string, number>;
  /**
   * Only files whose outcomeKey differs; largest group first. Empty while the
   * run is walking: the editor polls every second and renders changes only
   * once a run has finished, and rebuilding thousands of rows per poll for
   * nobody is what made the poll payload grow with the library.
   */
  changes: DryRunChangeGroup[];
}

export interface FlowDryRunDetail {
  fileId: string;
  path: string;
  outcome: DryRunOutcome;
  publishedOutcome: DryRunOutcome;
  /** Null when the walk threw for this file; the reason is `outcome.detail`. */
  canvas: FlowDryRunResult | null;
  published: FlowDryRunResult | null;
}

export interface FlowDryRunCoordinator {
  start(input: { flowId: string; definition: FlowDefinition; definitionHash: string }): {
    runId: string;
  };
  get(flowId: string, runId: string): DryRunRunView | null;
  /** Only files whose canvas and published outcomes differ keep a detail; any other is null. */
  file(flowId: string, runId: string, fileId: string): FlowDryRunDetail | null;
  /**
   * False when there is no such run. A running run is cancelled and stays
   * readable (as `cancelled`); a run that is no longer running is dropped.
   */
  cancel(flowId: string, runId: string): boolean;
  /**
   * The editor's Cancel: stops the run if it is still walking and returns it as
   * it now stands, null when there is no such run. Unlike `cancel` it never
   * drops a finished run — a Cancel clicked in the second after a run finished
   * used to delete the result it was about to show, leaving the panel on
   * "running" behind a 404.
   */
  stop(flowId: string, runId: string): DryRunRunView | null;
  /** Cancels every run and resolves when none is walking. Daemon shutdown awaits this before closing the db. */
  stopAll(): Promise<void>;
}

interface Run {
  runId: string;
  flowId: string;
  status: DryRunStatus;
  error: string | null;
  processed: number;
  total: number;
  definitionHash: string;
  publishedHash: string;
  counts: Record<string, number>;
  /**
   * Full walks, kept ONLY for files whose outcome changes: those are the only
   * ones the editor can open, and two complete results per file for a whole
   * library held for the life of the daemon ran to well over 100MB.
   */
  changed: Map<string, FlowDryRunDetail>;
  cancelled: boolean;
}

const groupChanges = (changed: Iterable<FlowDryRunDetail>): DryRunChangeGroup[] => {
  const groups = new Map<string, DryRunChangeGroup>();
  for (const row of changed) {
    const id = `${outcomeKey(row.publishedOutcome)} -> ${outcomeKey(row.outcome)}`;
    const group = groups.get(id) ?? { from: row.publishedOutcome, to: row.outcome, files: [] };
    group.files.push({ fileId: row.fileId, path: row.path });
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => b.files.length - a.files.length);
};

const view = (run: Run): DryRunRunView => ({
  runId: run.runId,
  flowId: run.flowId,
  status: run.status,
  error: run.error,
  processed: run.processed,
  total: run.total,
  definitionHash: run.definitionHash,
  publishedHash: run.publishedHash,
  counts: { ...run.counts },
  changes: run.status === 'running' ? [] : groupChanges(run.changed.values()),
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createFlowDryRunCoordinator = (input: {
  db: Db;
  binaries: () => { ffmpeg: string; ffprobe: string };
  nowMs: () => number;
  /** Seam for tests. Defaults to `dryRunFlow`. */
  dryRun?: typeof dryRunFlow;
}): FlowDryRunCoordinator => {
  const dryRun = input.dryRun ?? dryRunFlow;
  const flows = createFlowRepo(input.db);
  const runs = new Map<string, Run>();
  // Tracked apart from `runs`: a replaced, dropped or evicted run is no
  // longer reachable there, but its walk may be mid-file, reading the
  // database, and `stopAll` must still wait for it.
  const walking = new Set<Promise<void>>();

  const cancelRun = (run: Run): void => {
    if (run.status !== 'running') return;
    run.cancelled = true;
    run.status = 'cancelled';
  };

  // A deleted flow's run can never be asked for again through the API (every
  // route 404s on the flow first), so without this its results would sit in
  // memory until the daemon restarts.
  const evictIfFlowGone = (flowId: string): boolean => {
    const run = runs.get(flowId);
    if (run === undefined || flows.getById(flowId) !== null) return false;
    cancelRun(run);
    runs.delete(flowId);
    return true;
  };

  const find = (flowId: string, runId: string): Run | null => {
    if (evictIfFlowGone(flowId)) return null;
    const run = runs.get(flowId);
    return run !== undefined && run.runId === runId ? run : null;
  };

  const walk = async (
    run: Run,
    definition: FlowDefinition,
    published: FlowDefinition,
    snapshot: Array<{ id: string; path: string }>,
  ): Promise<void> => {
    // Binaries are read per attempt rather than once per run, so a path fixed
    // in settings mid-walk applies to the files still ahead.
    const attempt = async (
      fileId: string,
      override: FlowDefinition,
    ): Promise<{ result: FlowDryRunResult | null; outcome: DryRunOutcome }> => {
      try {
        const binaries = input.binaries();
        const result = await dryRun({
          db: input.db,
          flowId: run.flowId,
          fileId,
          definition: override,
          ffmpegPath: binaries.ffmpeg,
          ffprobePath: binaries.ffprobe,
          nowMs: input.nowMs,
        });
        return { result, outcome: classifyDryRun(result) };
      } catch (error) {
        // One unprobed or vanished file is a fact about that file, not a
        // reason to abandon the preview of the other thousands.
        return { result: null, outcome: { kind: 'fail', detail: messageOf(error) } };
      }
    };

    try {
      for (const file of snapshot) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (run.cancelled) return;
        const canvas = await attempt(file.id, definition);
        // Checked again between the halves: a cancel that landed during the
        // canvas walk must not spend a second walk on a run nobody wants, nor
        // add a row to a run that already reads `cancelled`.
        if (run.cancelled) return;
        const publishedHalf = await attempt(file.id, published);
        if (run.cancelled) return;
        const key = outcomeKey(canvas.outcome);
        run.counts[key] = (run.counts[key] ?? 0) + 1;
        run.processed += 1;
        if (outcomeKey(publishedHalf.outcome) !== key) {
          run.changed.set(file.id, {
            fileId: file.id,
            path: file.path,
            outcome: canvas.outcome,
            publishedOutcome: publishedHalf.outcome,
            canvas: canvas.result,
            published: publishedHalf.result,
          });
        }
      }
      if (!run.cancelled) run.status = 'done';
    } catch (error) {
      if (!run.cancelled) {
        run.status = 'failed';
        run.error = messageOf(error);
      }
    }
  };

  return {
    start({ flowId, definition, definitionHash }) {
      for (const id of [...runs.keys()]) evictIfFlowGone(id);
      const flow = flows.getById(flowId);
      if (flow === null) throw new DryRunInputError(`Unknown flow: ${flowId}`);
      const snapshot = input.db
        .prepare(
          `SELECT f.id, f.path FROM media_file f JOIN library l ON l.id = f.library_id
           WHERE l.flow_id = ? AND f.missing_since_ms IS NULL ORDER BY f.path`,
        )
        .all(flowId) as Array<{ id: string; path: string }>;

      const previous = runs.get(flowId);
      if (previous !== undefined) cancelRun(previous);

      const run: Run = {
        runId: randomUUID(),
        flowId,
        status: 'running',
        error: null,
        processed: 0,
        total: snapshot.length,
        definitionHash,
        publishedHash: flow.definitionHash,
        counts: {},
        changed: new Map(),
        cancelled: false,
      };
      runs.set(flowId, run);
      // The published half walks the definition as it stood at THIS moment,
      // passed explicitly: left to re-read the stored flow per file, a publish
      // mid-run would compare later files against a newer definition than the
      // `publishedHash` this run reports.
      const walked = walk(run, definition, flow.definition, snapshot);
      walking.add(walked);
      void walked.finally(() => walking.delete(walked));
      return { runId: run.runId };
    },

    get(flowId, runId) {
      const run = find(flowId, runId);
      return run === null ? null : view(run);
    },

    stop(flowId, runId) {
      const run = find(flowId, runId);
      if (run === null) return null;
      cancelRun(run);
      return view(run);
    },

    file(flowId, runId, fileId) {
      return find(flowId, runId)?.changed.get(fileId) ?? null;
    },

    cancel(flowId, runId) {
      const run = find(flowId, runId);
      if (run === null) return false;
      if (run.status === 'running') cancelRun(run);
      // A finished run is only memory by now: whoever deletes it is done
      // reading it, and nothing else would ever free it.
      else runs.delete(flowId);
      return true;
    },

    async stopAll() {
      for (const run of runs.values()) cancelRun(run);
      await Promise.all([...walking]);
    },
  };
};
