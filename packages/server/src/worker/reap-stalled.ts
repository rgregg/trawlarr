import { applyStall, newLedgerRecord } from '@trawlarr/core';
import type { Db } from '../db/connection.js';
import { createJobRepo } from '../db/job-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';

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
 *    claim. This is the ONLY evidence for an attempt with no job row at
 *    all: a worker killed between `claimNext` committing `running` and
 *    `jobRepo.start` inserting its row leaves nothing else behind, and that
 *    row is otherwise permanently unreachable (`claimNext` takes only
 *    `queued`/`held`, and the scanner refuses to touch `running`).
 *  - the latest job's `heartbeat_at`, falling back to its `started_at` — the
 *    normal case, and the only one that distinguishes a live long step from
 *    a dead worker.
 *  - the latest job's `ended_at` — an ended job is not a live worker, but it
 *    IS recent activity. The early-stall path records a synthetic job row
 *    and finishes it immediately, and that path is newer than the rest of
 *    this machinery; treating its recency as evidence keeps a row that was
 *    just written to from being reclaimed out from under whatever wrote it.
 */
const lastActivityOf = (db: Db, row: MediaFileRow): number => {
  const latest = createJobRepo(db).listForFile(row.id)[0];
  if (latest === undefined) return row.updated_at;
  return Math.max(
    row.updated_at,
    latest.heartbeatAt ?? latest.startedAt,
    latest.endedAt ?? Number.NEGATIVE_INFINITY,
  );
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
 * WHY THIS CANNOT TAKE LIVE WORK: see `DEFAULT_STALE_AFTER_MS`. The
 * threshold is a day and cannot be set below an hour; every source of
 * "recent" is taken at its most generous (`lastActivityOf` takes the MAX,
 * so any one signal of life protects the row); and the reclaim itself
 * re-reads the row inside its own transaction, so a row that left `running`
 * between the read and the write is left exactly as it was found.
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
    const lastActivityMs = lastActivityOf(db, row);
    if (input.nowMs - lastActivityMs <= staleAfterMs) {
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
        const latest = jobRepo.listForFile(row.id)[0];
        if (latest !== undefined && latest.endedAt === null) {
          jobRepo.finish({
            jobId: latest.id,
            state: 'failed',
            outcome:
              `Reclaimed by the stall reaper: no sign of life for ` +
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
