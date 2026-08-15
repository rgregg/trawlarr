import type { FileState } from '@trawlarr/core';
import type { Db } from '../db/connection.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { runJob, type RunJobInput, type RunJobResult } from './run-job.js';

export interface LoopSummary {
  /** Files claimed this drain, regardless of outcome. */
  claimed: number;
  /** Claimed files that converged to `good` this run. */
  succeeded: number;
  /**
   * Claimed files that reached the TERMINAL `failed` ledger state (backoff
   * exhausted at `MAX_ATTEMPTS`) — OR whose attempt itself threw before any
   * ledger state could be recorded at all (an unexpected error escaping
   * `runJob`: a bug, `SQLITE_BUSY`, a claimed row that vanished under it).
   * That second case is the one contributor to this count whose row may NOT
   * literally read `failed` in the database — it can be left `running`,
   * with no automatic recovery today (see the loop's own doc comment) —
   * every other contributor's row genuinely is `failed`.
   */
  failed: number;
  /**
   * Claimed files set aside rather than resolved either way this run:
   * always equals `heldForRetry + notConverging`. Kept for backward
   * compatibility; prefer the two fields below when the distinction
   * matters, since they call for opposite operator action (wait, versus go
   * look at this file).
   */
  skipped: number;
  /** Claimed files now `held`: backed off, eligible again once the hold expires. */
  heldForRetry: number;
  /** Claimed files now `not_converging` (the one-strike rule): terminal, needs a human. */
  notConverging: number;
  /**
   * Files left `queued`/`held` in a currently-paused (`enabled = 0`)
   * library at the end of this drain — never claimed. A best-effort count,
   * not a guarantee every one of them would have been claimable this very
   * instant if the library were enabled (a `held` file's own backoff may
   * not have expired yet either); it answers "how much backlog is a pause
   * hiding", not "how many claims did this pause cost".
   */
  pausedSkipped: number;
}

export interface RunQueueInput {
  db: Db;
  ffmpegPath: string;
  ffprobePath: string;
  nowMs: () => number;
  /**
   * Restrict the drain to these libraries. `undefined` (the default) means
   * every currently-enabled library. An explicit `[]` means "claim
   * nothing" — NOT "no filter" — since it is intersected with the enabled
   * set exactly like any other explicit list; pass `undefined`, not `[]`,
   * for "no library filter specified".
   */
  libraryIds?: string[];
  maxFiles?: number;
  signal?: AbortSignal;
  onFile?: (event: { fileId: string; path: string; state: FileState }) => void;
  /**
   * Seam for tests: substitute `runJob` itself. Defaults to the real
   * `runJob`; production code never sets this. Exists so a test can force
   * `runJob` to throw for a specific claimed file — deterministically, and
   * through the same call site production uses — without needing a
   * genuinely broken database or filesystem to provoke it for real.
   */
  runJobFn?: (input: RunJobInput) => Promise<RunJobResult>;
}

/** Matches the value `runJob`'s own `buildArgs` call already hard-codes (see run-job.ts). */
const WORKER_CLASS = 'transcode';

/**
 * Drain the queue, one file at a time, unattended: claim through the
 * atomic `claimNext`, run it to completion with `runJob`, fold the result
 * into a summary, and repeat — until `claimNext` finds nothing left to
 * claim, `maxFiles` claims have happened, or `signal` aborts. Sequential by
 * design: worker classes and concurrency caps are P2b (see the task brief);
 * one worker converging a library unattended is all this needs to do.
 *
 * `claimNext` itself has no notion of "library enabled" — it is purely a
 * state/hold-time query — so a paused library's backlog would otherwise be
 * claimed and run exactly like any other. Before every claim, this loop
 * recomputes the set of currently-enabled libraries (a library can be
 * paused mid-drain) and intersects it with `input.libraryIds` when given,
 * then always passes that explicit list to `claimNext`. A paused library's
 * files are therefore never claimed at all — they stay `queued`, not
 * claimed-then-abandoned — which is simpler and safer than claiming one and
 * unwinding it afterwards. `LoopSummary.pausedSkipped` reports how big that
 * untouched backlog is once the drain ends.
 *
 * The signal is checked only BETWEEN files, never while a claimed file's
 * `runJob` is in flight. `runJob` has no cancellation story of its own today
 * (its only exits are success, a recorded failure, or a caught stall) and a
 * claimed row has already begun mutating a real file on disk (a scratch
 * workDir, a trash move, an in-place replace) — interrupting it partway
 * would abandon a change with nothing left to finish or roll it back.
 * Stopping faster than "let the current file finish" means killing the
 * worker at the OS process level, which is a concern for whoever launches
 * the worker process, not this loop: nothing here spawns a child process
 * directly, so nothing here needs to manage a process group either. (A real
 * gap remains one layer down — `packages/engine/src/ffmpeg/run.ts` kills
 * only ffmpeg's direct pid, not its process group, so a plugin-spawned
 * descendant of ffmpeg would survive even a future mid-file cancellation —
 * but this loop's own abort semantics never reach that code path, so fixing
 * it belongs to whichever task actually wires mid-file cancellation.)
 *
 * Neither `runJob` throwing nor a caller-supplied `onFile` throwing is
 * allowed to abort the drain: both are caught per-iteration, so a bug in
 * one file's processing (or one CLI callback) never stops the rest of the
 * queue from being worked and never loses the counts already collected —
 * this function's only contract is that it ALWAYS resolves with the
 * summary so far, never rejects. A `runJob` throw still counts the file as
 * `failed` (see `LoopSummary.failed`'s doc comment) and moves on; there is
 * no stall reaper anywhere in the server today, so a row left `running` by
 * a throw before `runJob` reached its own try block has no automatic way
 * back to `queued` — only a manual `requeue`. Recorded here, not fixed here:
 * that is a gap in `runJob`/a future reaper, not something this loop can
 * paper over from the outside.
 *
 * NOTE: `maxFiles` bounds the number of CLAIMS, not the number of distinct
 * files. A file whose `held` backoff expires partway through a drain can be
 * claimed a second time in the same pass (after failing once, going back
 * through `claimNext`, and being picked up again before the loop stops) —
 * bounded by `MAX_ATTEMPTS` (3) at the ledger level, so not a liveness
 * bug, but `maxFiles: 10` does not always mean ten distinct files touched.
 *
 * NOTE: `WORKER_CLASS` is currently decorative. `claimNext`'s SQL filters
 * only on `state`/`hold_until_ms`/`library_id` — it never references
 * `worker_class` — so passing it here reserves the field for when worker
 * classes actually gate claiming (P2b) without doing anything yet.
 */
export const runQueue = async (input: RunQueueInput): Promise<LoopSummary> => {
  const mediaFileRepo = createMediaFileRepo(input.db);
  const libraryRepo = createLibraryRepo(input.db);
  const runJobFn = input.runJobFn ?? runJob;

  const summary: LoopSummary = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    heldForRetry: 0,
    notConverging: 0,
    pausedSkipped: 0,
  };

  for (;;) {
    if (input.signal?.aborted === true) break;
    if (input.maxFiles !== undefined && summary.claimed >= input.maxFiles) break;

    const enabledLibraryIds = new Set(
      libraryRepo
        .list()
        .filter((library) => library.enabled)
        .map((library) => library.id),
    );
    const eligibleLibraryIds =
      input.libraryIds === undefined
        ? [...enabledLibraryIds]
        : input.libraryIds.filter((id) => enabledLibraryIds.has(id));

    const claimed = mediaFileRepo.claimNext({
      workerClass: WORKER_CLASS,
      nowMs: input.nowMs(),
      libraryIds: eligibleLibraryIds,
    });
    if (claimed === null) break;

    summary.claimed += 1;

    let result: RunJobResult;
    try {
      result = await runJobFn({
        db: input.db,
        claimed,
        ffmpegPath: input.ffmpegPath,
        ffprobePath: input.ffprobePath,
        nowMs: input.nowMs,
      });
    } catch {
      // An unexpected throw from runJob (see the doc comment above) must
      // not take the whole drain down with it: the file is counted failed,
      // and the loop moves on to whatever is claimable next. There is no
      // coherent `FileState`/path to report for this claim (the row's real
      // state after an unexplained throw is not something this loop can
      // trust), so `onFile` is deliberately not called for it.
      summary.failed += 1;
      continue;
    }

    if (result.state === 'good') summary.succeeded += 1;
    else if (result.state === 'failed') summary.failed += 1;
    else if (result.state === 'held') {
      summary.heldForRetry += 1;
      summary.skipped += 1;
    } else if (result.state === 'not_converging') {
      summary.notConverging += 1;
      summary.skipped += 1;
    } else {
      // Defensive: runJob should never resolve a claimed file to
      // unknown/queued/running, but if it somehow did, that is closer to
      // "set aside" than to either a success or a terminal failure.
      summary.skipped += 1;
    }

    // The row may hold a NEW path by now (a container-changing replace
    // renames it) — `claimed.path` is only what it was BEFORE this run.
    // Reading it back from the row, rather than widening RunJobResult,
    // keeps run-job.ts untouched: this loop already knows how to ask for a
    // media file row by id.
    const finalPath = mediaFileRepo.getById(claimed.fileId)?.path ?? claimed.path;

    try {
      input.onFile?.({ fileId: claimed.fileId, path: finalPath, state: result.state });
    } catch {
      // A caller's callback misbehaving (a formatting bug, closed stdout)
      // must not abort the drain either — the outcome above is already
      // recorded in `summary` and the database regardless of what the
      // callback does with it.
    }
  }

  const pausedLibraries = libraryRepo.list().filter((library) => !library.enabled);
  summary.pausedSkipped = pausedLibraries.reduce((total, library) => {
    const counts = mediaFileRepo.countsByState(library.id);
    return total + counts.queued + counts.held;
  }, 0);

  return summary;
};
