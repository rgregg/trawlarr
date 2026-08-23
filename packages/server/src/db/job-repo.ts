import { randomUUID } from 'node:crypto';
import type { WorkerClass } from '@trawlarr/core';
import type { Db } from './connection.js';

export interface JobRow {
  id: string;
  fileId: string;
  flowId: string;
  flowHash: string;
  nodeId: string | null;
  workerClass: string;
  state: string;
  outcome: string | null;
  logPath: string | null;
  startedAt: number;
  heartbeatAt: number | null;
  endedAt: number | null;
  /**
   * The pid of the worker process running this job, and the host whose pid
   * table that number belongs to. Both null until `setWorker` is called, and
   * null forever for a run that forks no worker at all (`trawlarr run`).
   * See `006_job_worker_identity.sql`.
   */
  workerPid: number | null;
  workerHost: string | null;
}

export interface JobStepRow {
  id: number;
  jobId: string;
  seq: number;
  nodeId: string;
  pluginId: string;
  outputNumber: number | null;
  durationMs: number;
  logExcerpt: string;
}

export interface StartJobInput {
  fileId: string;
  flowId: string;
  flowHash: string;
  nowMs: number;
  /**
   * Defaults to 'transcode' when omitted, matching the column default.
   *
   * A job's own row is the only place the class it ran under is recorded:
   * the file it ran on says nothing about it, and the worker that ran it is
   * gone by the time anyone asks.
   */
  workerClass?: WorkerClass;
  /** The node this job ran on. NULL until the local node registers itself. */
  nodeId?: string | null;
  /**
   * A caller-supplied id, generated with `randomUUID()` before the row
   * exists. Optional and rare: the one real caller is the supervisor, which
   * has to know the job's id BEFORE this call returns — the on-disk log
   * path both this row's `log_path` and the payload handed to the worker
   * must agree on is named after it, and there is no way to allocate a path
   * from an id this function has not generated yet. Every other caller
   * leaves this unset and gets the usual freshly generated id.
   */
  id?: string;
  /**
   * Where this job's on-disk log will live, allocated by the daemon before
   * the worker even starts — so a worker that vanishes without writing a
   * byte still leaves a findable path on the job row. Optional — callers
   * that predate per-job logs (and tests exercising unrelated behaviour)
   * leave the column NULL, the same default the column has always had.
   */
  logPath?: string | null;
}

export interface RecordStepInput {
  jobId: string;
  step: {
    seq: number;
    nodeId: string;
    pluginId: string;
    outputNumber: number | null;
    durationMs: number;
    logExcerpt: string;
    /**
     * Folded into the persisted log excerpt: `job_step` has no dedicated
     * error column, so a failing step's error is what makes its log excerpt
     * distinguishable from a successful one's. See `job_step` in
     * `001_initial.sql`.
     */
    error?: string | null;
  };
}

export interface FinishJobInput {
  jobId: string;
  state: string;
  outcome: string;
  nowMs: number;
}

export interface HeartbeatInput {
  jobId: string;
  nowMs: number;
}

export interface SetWorkerInput {
  jobId: string;
  /** The forked worker's pid, or null when the fork never surfaced one. */
  pid: number | null;
  /** The host that pid belongs to; `os.hostname()` in every real caller. */
  host: string;
}

/**
 * A page of job rows plus the TOTAL the filter matched.
 *
 * The total is what makes a page navigable: a client that only gets the rows
 * cannot tell "this is the last page" from "the page size happened to match",
 * and a real library's job history is tens of thousands of rows.
 */
export interface JobPage {
  total: number;
  items: JobRow[];
}

export interface QueryJobsInput {
  fileId?: string;
  state?: string;
  limit: number;
  offset: number;
}

export interface JobRepo {
  start(input: StartJobInput): string;
  recordStep(input: RecordStepInput): void;
  finish(input: FinishJobInput): void;
  heartbeat(input: HeartbeatInput): void;
  /**
   * Record which process is running this job.
   *
   * Separate from `start` because the two facts become available at
   * different moments and in that order: the row has to exist before the
   * worker is forked (the scanner's in-flight guard depends on the claim
   * being committed first), so the pid is not knowable when the row is
   * written. A job whose worker dies between the two calls keeps NULL and is
   * reclaimed by the reaper's time threshold, exactly as before.
   */
  setWorker(input: SetWorkerInput): void;
  listForFile(fileId: string): JobRow[];
  getById(jobId: string): JobRow | null;
  /** Filtered, paginated job history, newest first. */
  query(input: QueryJobsInput): JobPage;
  getSteps(jobId: string): JobStepRow[];
}

interface JobRowRaw {
  id: string;
  file_id: string;
  flow_id: string;
  flow_hash: string;
  node_id: string | null;
  worker_class: string;
  state: string;
  outcome: string | null;
  log_path: string | null;
  started_at: number;
  heartbeat_at: number | null;
  ended_at: number | null;
  worker_pid: number | null;
  worker_host: string | null;
}

interface JobStepRowRaw {
  id: number;
  job_id: string;
  seq: number;
  node_id: string;
  plugin_id: string;
  output_number: number | null;
  duration_ms: number;
  log_excerpt: string;
}

const toJobRow = (row: JobRowRaw): JobRow => ({
  id: row.id,
  fileId: row.file_id,
  flowId: row.flow_id,
  flowHash: row.flow_hash,
  nodeId: row.node_id,
  workerClass: row.worker_class,
  state: row.state,
  outcome: row.outcome,
  logPath: row.log_path,
  startedAt: row.started_at,
  heartbeatAt: row.heartbeat_at,
  endedAt: row.ended_at,
  workerPid: row.worker_pid,
  workerHost: row.worker_host,
});

const toJobStepRow = (row: JobStepRowRaw): JobStepRow => ({
  id: row.id,
  jobId: row.job_id,
  seq: row.seq,
  nodeId: row.node_id,
  pluginId: row.plugin_id,
  outputNumber: row.output_number,
  durationMs: row.duration_ms,
  logExcerpt: row.log_excerpt,
});

/** Appends the step's error (if any) to its log excerpt: see RecordStepInput.step.error. */
const logExcerptWithError = (logExcerpt: string, error: string | null | undefined): string => {
  if (error === null || error === undefined) return logExcerpt;
  return logExcerpt === '' ? `ERROR: ${error}` : `${logExcerpt}\nERROR: ${error}`;
};

/**
 * An "excerpt" that grows without bound is not one: a chatty community
 * plugin (or one that echoes ffmpeg's own progress lines through `jobLog`)
 * can write megabytes into a single step. Kept generous — several full
 * pages of log text — because the trace exists to answer "why did this file
 * get this decision", and a truncation aggressive enough to cut off the
 * actual error message defeats that.
 */
export const MAX_LOG_EXCERPT_CHARS = 8_000;

const truncateLogExcerpt = (text: string): string => {
  if (text.length <= MAX_LOG_EXCERPT_CHARS) return text;
  const kept = text.slice(0, MAX_LOG_EXCERPT_CHARS);
  const omitted = text.length - MAX_LOG_EXCERPT_CHARS;
  return `${kept}\n… [truncated, ${omitted} more characters]`;
};

/**
 * Records what happened to a file as it was driven through a flow: one `job`
 * row per attempt, and one `job_step` row per node the flow actually
 * visited — including a failing one, because the step trace is what makes
 * "why did this file get this decision?" answerable after the fact.
 */
export const createJobRepo = (db: Db): JobRepo => {
  const insertJob = db.prepare(
    `INSERT INTO job (id, file_id, flow_id, flow_hash, worker_class, node_id, log_path, state, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  );

  const insertStep = db.prepare(
    `INSERT INTO job_step (job_id, seq, node_id, plugin_id, output_number, duration_ms, log_excerpt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const finishJob = db.prepare(`UPDATE job SET state = ?, outcome = ?, ended_at = ? WHERE id = ?`);

  const heartbeatJob = db.prepare(`UPDATE job SET heartbeat_at = ? WHERE id = ?`);

  // Only while the job is still open. A `setWorker` that landed after the
  // run had already been folded in would attach a pid to a finished row,
  // which reads as "this ended job was run by a process that no longer
  // exists" -- true, and exactly the shape the reaper's fast path looks for.
  const setWorkerJob = db.prepare(
    `UPDATE job SET worker_pid = ?, worker_host = ? WHERE id = ? AND ended_at IS NULL`,
  );

  const selectForFile = db.prepare(`SELECT * FROM job WHERE file_id = ? ORDER BY started_at DESC`);

  const selectSteps = db.prepare(`SELECT * FROM job_step WHERE job_id = ? ORDER BY seq ASC`);

  return {
    start(input) {
      const id = input.id ?? randomUUID();
      insertJob.run(
        id,
        input.fileId,
        input.flowId,
        input.flowHash,
        input.workerClass ?? 'transcode',
        input.nodeId ?? null,
        input.logPath ?? null,
        input.nowMs,
      );
      return id;
    },

    recordStep(input) {
      const { step } = input;
      insertStep.run(
        input.jobId,
        step.seq,
        step.nodeId,
        step.pluginId,
        step.outputNumber,
        step.durationMs,
        truncateLogExcerpt(logExcerptWithError(step.logExcerpt, step.error)),
      );
    },

    finish(input) {
      finishJob.run(input.state, input.outcome, input.nowMs, input.jobId);
    },

    heartbeat(input) {
      heartbeatJob.run(input.nowMs, input.jobId);
    },

    setWorker(input) {
      setWorkerJob.run(input.pid, input.host, input.jobId);
    },

    listForFile(fileId) {
      return (selectForFile.all(fileId) as JobRowRaw[]).map(toJobRow);
    },

    getById(jobId) {
      const row = db.prepare(`SELECT * FROM job WHERE id = ?`).get(jobId) as JobRowRaw | undefined;
      return row === undefined ? null : toJobRow(row);
    },

    query(input) {
      // Both statements are built from the SAME where clause, so the total
      // can never describe a different filter than the rows do.
      const where: string[] = [];
      const params: unknown[] = [];
      if (input.fileId !== undefined) {
        where.push(`file_id = ?`);
        params.push(input.fileId);
      }
      if (input.state !== undefined) {
        where.push(`state = ?`);
        params.push(input.state);
      }
      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
      const total = (
        db.prepare(`SELECT COUNT(*) AS c FROM job ${clause}`).get(...params) as { c: number }
      ).c;
      const items = db
        .prepare(`SELECT * FROM job ${clause} ORDER BY started_at DESC, id ASC LIMIT ? OFFSET ?`)
        .all(...params, input.limit, input.offset) as JobRowRaw[];
      return { total, items: items.map(toJobRow) };
    },

    getSteps(jobId) {
      return (selectSteps.all(jobId) as JobStepRowRaw[]).map(toJobStepRow);
    },
  };
};
