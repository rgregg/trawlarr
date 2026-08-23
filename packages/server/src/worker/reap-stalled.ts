import { hostname } from 'node:os';
import { applyStall, newLedgerRecord } from '@trawlarr/core';
import type { Db } from '../db/connection.js';
import { createJobRepo, type JobRow } from '../db/job-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { processIsAlive } from '../daemon/process-alive.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a `running` row must have gone WITHOUT any sign of life before
 * it is treated as abandoned.
 *
 * A day, and the granularity of the heartbeat is why. `heartbeat_at` is
 * written at job start and after each COMPLETED step, and one step is a
 * whole node — an Execute step IS the transcode. A legitimate 4K remux of a
 * two-hour film on a slow CPU can run for many hours without a single step
 * boundary, so the gap between heartbeats on a perfectly healthy worker is
 * bounded by the longest single step, not by a polling interval. Any
 * threshold near "how often does a live worker check in" would therefore
 * reclaim files that are being encoded right now, and two workers on one
 * file is precisely how the destructive layer loses data: both compute the
 * same replacement path, and the trash/swap dance is only safe against
 * concurrency it can SEE.
 *
 * Twenty-four hours is comfortably longer than any single step a media file
 * plausibly produces, while still recovering an abandoned row inside a day
 * — and the cost of waiting is only latency on one file, whereas the cost
 * of being early is a corrupted replacement.
 */
export const DEFAULT_STALE_AFTER_MS = 24 * HOUR_MS;

/**
 * The shortest threshold this will accept at all. Below an hour, "no
 * heartbeat" stops meaning "dead worker" and starts meaning "long step",
 * for the reasons above — so a mistyped `--stale-after-hours` is refused
 * rather than quietly turned into a way to reclaim live work.
 */
export const MIN_STALE_AFTER_MS = HOUR_MS;

export class StaleThresholdTooShortError extends Error {
  constructor(staleAfterMs: number) {
    super(
      `A stall threshold of ${String(Math.round(staleAfterMs / 60_000))} minute(s) is too short. ` +
        `A job's heartbeat only advances between flow STEPS, and one step is a whole transcode ` +
        `— a multi-hour Execute is normal — so a threshold under ` +
        `${String(MIN_STALE_AFTER_MS / HOUR_MS)} hour(s) would reclaim files that are still ` +
        `being encoded, and two workers on one file is how a replacement destroys data. Use at ` +
        `least ${String(MIN_STALE_AFTER_MS / HOUR_MS)} hour(s) (the default is ` +
        `${String(DEFAULT_STALE_AFTER_MS / HOUR_MS)}).`,
    );
    this.name = 'StaleThresholdTooShortError';
  }
}

export interface ReapStalledInput {
  db: Db;
  nowMs: number;
  /** Defaults to {@link DEFAULT_STALE_AFTER_MS}; never below {@link MIN_STALE_AFTER_MS}. */
  staleAfterMs?: number;
  libraryIds?: string[];
  /** Report what would be reclaimed, change nothing. */
  dryRun?: boolean;
}

export interface ReapedFile {
  fileId: string;
  path: string;
  /** The newest sign of life found for this row. */
  lastActivityMs: number;
  /** The ledger state the reclaimed attempt resolved to (`held`/`failed`). */
  state: string;
}

export interface ReapSummary {
  /** `running` rows examined. */
  running: number;
  /** Rows reclaimed (or, under `dryRun`, that would have been). */
  reclaimed: number;
  /** Rows left alone because something about them is recent enough to be alive. */
  live: number;
  files: ReapedFile[];
}

/**
 * The newest evidence that anything at all was happening to this row.
 *
 * Three sources, and the most recent of them wins, because each covers a
 * case the others cannot:
 *
 *  - `media_file.updated_at` — stamped by `claimNext` at the moment of the
 *    claim, AND CONSULTED ONLY WHEN THERE IS NO JOB ROW. It is the only
 *    evidence for an attempt that never got one: a worker killed between
 *    `claimNext` committing `running` and `jobRepo.start` inserting its row
 *    leaves nothing else behind, and that row is otherwise permanently
 *    unreachable (`claimNext` takes only `queued`/`held`, and the scanner
 *    refuses to touch `running`).
 *
 *    IT IS NOT A SIGN OF LIFE ONCE A JOB ROW EXISTS, and taking it as one
 *    was a bug that disabled this whole mechanism on any library that is
 *    still being scanned. `upsertScanned` writes `updated_at = now` on
 *    EVERY row it matches, on every walk — including a `running` one, whose
 *    file is present and unchanged and therefore matched by identity like
 *    any other. (The in-flight-output guard does not cover it: that guard
 *    only fires for a walked file that matches NO row.) So each periodic
 *    rescan refreshed the stranded row's `updated_at`, the MAX below never
 *    aged past the threshold, and a row abandoned by a dead worker was
 *    counted `live` for ever — the row would outlive the daemon, the
 *    machine and the operator's patience, which is precisely what was
 *    observed on the owner's library. Nothing is lost by dropping it: a
 *    job row's `started_at` is written immediately after the claim that set
 *    `updated_at`, so it is never the older of the two.
 *  - the latest job's `heartbeat_at`, falling back to its `started_at` — the
 *    normal case, and the only one that distinguishes a live long step from
 *    a dead worker.
 *  - the latest job's `ended_at` — an ended job is not a live worker, but it
 *    IS recent activity. The early-stall path records a synthetic job row
 *    and finishes it immediately, and that path is newer than the rest of
 *    this machinery; treating its recency as evidence keeps a row that was
 *    just written to from being reclaimed out from under whatever wrote it.
 */
const lastActivityOf = (row: MediaFileRow, latest: JobRow | undefined): number => {
  if (latest === undefined) return row.updated_at;
  return Math.max(
    latest.heartbeatAt ?? latest.startedAt,
    latest.endedAt ?? Number.NEGATIVE_INFINITY,
  );
};

/**
 * Is the process that was running this job PROVABLY not there any more?
 *
 * The time threshold above is a guess about liveness, and a deliberately
 * slow one, because a silent worker is indistinguishable from one three
 * hours into an Execute step. This is not a guess. The daemon forked the
 * worker itself and wrote down its pid (`jobRepo.setWorker`); a pid that
 * does not exist in this host's process table is a process that has ended.
 *
 * Every condition here exists to keep the answer FALSE whenever there is any
 * doubt at all, because the only expensive error is declaring a live encode
 * dead and handing its file to a second worker:
 *
 *  - no job row, or no recorded pid: nothing to check (an in-process
 *    `trawlarr run`, a job from before the column existed, a worker whose
 *    fork never surfaced a pid). Falls back to the threshold.
 *  - a job that has ENDED: its row is not what is holding the file, and
 *    reclaiming on the strength of it would race whatever is writing the
 *    outcome right now.
 *  - a pid recorded on a DIFFERENT host: this host's process table says
 *    nothing about it. Without this check a second node would read its own
 *    pids and conclude that a worker transcoding perfectly well elsewhere
 *    had died — the one error that must never be made.
 *  - `processIsAlive` itself resolves every ambiguity (EPERM, a reused pid)
 *    to alive, so a wrong answer here is always the harmless one: the row
 *    waits out the day-long threshold exactly as it did before.
 */
const workerProvablyGone = (latest: JobRow | undefined): boolean => {
  if (latest === undefined) return false;
  if (latest.endedAt !== null) return false;
  if (latest.workerPid === null) return false;
  if (latest.workerHost !== hostname()) return false;
  return !processIsAlive(latest.workerPid);
};

/**
 * Recover rows stranded in `running` by a worker that died.
 *
 * Nothing else can: `claimNext` only takes `queued`/`held`, the scanner
 * lists `running` in `NEVER_REQUEUE_STATES`, and `runJob`'s own stall
 * handler cannot run in a process that has been killed. Before this, the
 * only recovery was a human noticing and running `trawlarr requeue`.
 *
 * A reclaimed attempt is folded through `applyStall` — the same "failed
 * attempt" `runJob` records when an attempt dies for a reason it CAN see —
 * not through `requeue`. That is deliberate: `requeue` clears the attempt
 * counter and the backoff, so a file that reliably kills its worker (an
 * OOM on a huge transcode is the obvious one) would be picked up, kill the
 * worker again, be reclaimed again, for ever. Through `applyStall` it backs
 * off and, after `MAX_ATTEMPTS`, becomes terminal and visible.
 *
 * A row is abandoned if EITHER of two independent things is true, and they
 * are not the same kind of statement:
 *
 *  - `workerProvablyGone` — the pid the daemon forked for this job is not in
 *    this host's process table. A fact, and immediate: a claim whose worker
 *    is provably gone should not wait a day for a human or a clock.
 *  - the time threshold — no sign of life for `staleAfterMs`. An inference,
 *    and the only route available for a row the first cannot speak about.
 *
 * WHY NEITHER CAN TAKE LIVE WORK. For the threshold: see
 * `DEFAULT_STALE_AFTER_MS`; it is a day, cannot be set below an hour, and
 * `lastActivityOf` takes the MAX of every signal, so any one sign of life
 * protects the row. For the pid: see `workerProvablyGone`; every ambiguity
 * — an unknown pid, another host, a permission error, a reused pid —
 * resolves to "alive", so it can only ever reclaim EARLIER than the
 * threshold would, never something the threshold would have protected. And
 * for both, the reclaim re-reads the row inside its own transaction, so a
 * row that left `running` between the decision and the write is left
 * exactly as it was found.
 */
export const reapStalled = (input: ReapStalledInput): ReapSummary => {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (staleAfterMs < MIN_STALE_AFTER_MS) throw new StaleThresholdTooShortError(staleAfterMs);

  const { db } = input;
  const mediaFileRepo = createMediaFileRepo(db);
  const jobRepo = createJobRepo(db);

  const rows = (
    input.libraryIds === undefined
      ? (db.prepare(`SELECT * FROM media_file WHERE state = 'running'`).all() as MediaFileRow[])
      : input.libraryIds.flatMap((libraryId) =>
          mediaFileRepo.listByLibrary({ libraryId, state: 'running' }),
        )
  ).sort((a, b) => a.path.localeCompare(b.path));

  const summary: ReapSummary = { running: rows.length, reclaimed: 0, live: 0, files: [] };

  for (const row of rows) {
    const latest = jobRepo.listForFile(row.id)[0];
    const lastActivityMs = lastActivityOf(row, latest);
    // Two independent routes to "abandoned", and the row needs only one.
    // The pid route is the fast one and is a FACT; the threshold is the slow
    // one and is an inference, and it remains the only route for every row
    // the fast one cannot speak about.
    if (!workerProvablyGone(latest) && input.nowMs - lastActivityMs <= staleAfterMs) {
      summary.live += 1;
      continue;
    }

    const stalled = applyStall({
      record: mediaFileRepo.getLedger(row.id) ?? newLedgerRecord(),
      nowMs: input.nowMs,
    });

    if (input.dryRun !== true) {
      db.transaction(() => {
        // Re-read under the write: a worker can have finished (or a human
        // requeued the row) between the decision above and this write, and
        // overwriting THAT with a stall would erase a real outcome.
        const current = mediaFileRepo.getById(row.id);
        if (current === null || current.state !== 'running') return;
        mediaFileRepo.setLedger({ fileId: row.id, record: stalled });

        // Close the job row the dead worker left open, so it stops reading
        // as in-flight to anything that looks at job history. An already
        // finished job is left alone: its own outcome is the true one.
        const latestNow = jobRepo.listForFile(row.id)[0];
        if (latestNow !== undefined && latestNow.endedAt === null) {
          jobRepo.finish({
            jobId: latestNow.id,
            state: 'failed',
            outcome: workerProvablyGone(latestNow)
              ? `Reclaimed by the stall reaper: the worker running this job (pid ` +
                `${String(latestNow.workerPid)} on ${String(latestNow.workerHost)}) no longer ` +
                `exists, so it cannot still be working on this file.`
              : `Reclaimed by the stall reaper: no sign of life for ` +
                `${String(Math.round((input.nowMs - lastActivityMs) / HOUR_MS))} hour(s), so the ` +
                `worker running this job is presumed dead.`,
            nowMs: input.nowMs,
          });
        }
      })();
    }

    summary.reclaimed += 1;
    summary.files.push({
      fileId: row.id,
      path: row.path,
      lastActivityMs,
      state: stalled.state,
    });
  }

  return summary;
};
