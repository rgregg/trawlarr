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

export interface DryRunFileRow {
  fileId: string;
  path: string;
  outcome: DryRunOutcome;
  publishedOutcome: DryRunOutcome;
}

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
  /** Only files whose outcomeKey differs; largest group first. */
  changes: DryRunChangeGroup[];
  files: DryRunFileRow[];
}

export interface FlowDryRunDetail {
  fileId: string;
  path: string;
  /** Null when the walk threw for this file; the reason is the row's `fail` outcome. */
  canvas: FlowDryRunResult | null;
  published: FlowDryRunResult | null;
}

export interface FlowDryRunCoordinator {
  start(input: { flowId: string; definition: FlowDefinition; definitionHash: string }): {
    runId: string;
  };
  get(flowId: string, runId: string): DryRunRunView | null;
  file(flowId: string, runId: string, fileId: string): FlowDryRunDetail | null;
  cancel(flowId: string, runId: string): boolean;
  /** Cancels every run and resolves when none is walking. Daemon shutdown awaits this before closing the db. */
  stopAll(): Promise<void>;
}

interface Run {
  runId: string;
  flowId: string;
  status: DryRunStatus;
  error: string | null;
  total: number;
  definitionHash: string;
  publishedHash: string;
  files: DryRunFileRow[];
  results: Map<string, { canvas: FlowDryRunResult | null; published: FlowDryRunResult | null }>;
  cancelled: boolean;
  walking: Promise<void>;
}

const summarise = (files: DryRunFileRow[]) => {
  const counts: Record<string, number> = {};
  const groups = new Map<string, DryRunChangeGroup>();
  for (const row of files) {
    const key = outcomeKey(row.outcome);
    counts[key] = (counts[key] ?? 0) + 1;
    const from = outcomeKey(row.publishedOutcome);
    if (from === key) continue;
    const id = `${from} -> ${key}`;
    const group = groups.get(id) ?? { from: row.publishedOutcome, to: row.outcome, files: [] };
    group.files.push({ fileId: row.fileId, path: row.path });
    groups.set(id, group);
  }
  return { counts, changes: [...groups.values()].sort((a, b) => b.files.length - a.files.length) };
};

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
  const runs = new Map<string, Run>();

  const find = (flowId: string, runId: string): Run | null => {
    const run = runs.get(flowId);
    return run !== undefined && run.runId === runId ? run : null;
  };

  const cancelRun = (run: Run): void => {
    if (run.status !== 'running') return;
    run.cancelled = true;
    run.status = 'cancelled';
  };

  const walk = async (
    run: Run,
    definition: FlowDefinition,
    snapshot: Array<{ id: string; path: string }>,
  ): Promise<void> => {
    // Binaries are read per attempt rather than once per run, so a path fixed
    // in settings mid-walk applies to the files still ahead.
    const attempt = async (
      fileId: string,
      override: FlowDefinition | undefined,
    ): Promise<{ result: FlowDryRunResult | null; outcome: DryRunOutcome }> => {
      try {
        const binaries = input.binaries();
        const result = await dryRun({
          db: input.db,
          flowId: run.flowId,
          fileId,
          ...(override === undefined ? {} : { definition: override }),
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
        const published = await attempt(file.id, undefined);
        run.results.set(file.id, { canvas: canvas.result, published: published.result });
        run.files.push({
          fileId: file.id,
          path: file.path,
          outcome: canvas.outcome,
          publishedOutcome: published.outcome,
        });
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
      const flow = createFlowRepo(input.db).getById(flowId);
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
        total: snapshot.length,
        definitionHash,
        publishedHash: flow.definitionHash,
        files: [],
        results: new Map(),
        cancelled: false,
        walking: Promise.resolve(),
      };
      runs.set(flowId, run);
      run.walking = walk(run, definition, snapshot);
      // The cancelled predecessor is no longer reachable through `runs`, but
      // `stopAll` must still wait for it: its walk may be mid-file, reading
      // the database.
      if (previous !== undefined) {
        const tail = previous.walking;
        run.walking = Promise.all([run.walking, tail]).then(() => undefined);
      }
      return { runId: run.runId };
    },

    get(flowId, runId) {
      const run = find(flowId, runId);
      if (run === null) return null;
      const files = [...run.files];
      return {
        runId: run.runId,
        flowId: run.flowId,
        status: run.status,
        error: run.error,
        processed: files.length,
        total: run.total,
        definitionHash: run.definitionHash,
        publishedHash: run.publishedHash,
        ...summarise(files),
        files,
      };
    },

    file(flowId, runId, fileId) {
      const run = find(flowId, runId);
      const results = run?.results.get(fileId);
      if (run === null || results === undefined) return null;
      const row = run.files.find((candidate) => candidate.fileId === fileId);
      if (row === undefined) return null;
      return { fileId, path: row.path, canvas: results.canvas, published: results.published };
    },

    cancel(flowId, runId) {
      const run = find(flowId, runId);
      if (run === null || run.status !== 'running') return false;
      cancelRun(run);
      return true;
    },

    async stopAll() {
      const all = [...runs.values()];
      for (const run of all) cancelRun(run);
      await Promise.all(all.map((run) => run.walking));
    },
  };
};
