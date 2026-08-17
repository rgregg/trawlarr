import type { FileState } from '@trawlarr/core';
import type { Db } from '../db/connection.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo, type ClaimedFile, type MediaFileRow } from '../db/media-file-repo.js';
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
   * library at the end of this drain — never claimed THIS drain. A
   * best-effort count, not a guarantee every one of them would have been
   * claimable this very instant if the library were enabled (a `held`
   * file's own backoff may not have expired yet either); it answers "how
   * much backlog is a pause hiding", not "how many claims did this pause
   * cost". Explicitly excludes any file THIS drain itself claimed and
   * already accounted for elsewhere in this summary (`succeeded`/`failed`/
   * `heldForRetry`/`notConverging`) — a library paused partway through a
   * drain must not have one of its already-worked files counted twice,
   * once as its real outcome and again here just because the library
   * happened to be disabled by the time the drain finished. If computing
   * this tally itself fails partway through (see the loop's own doc
   * comment), it is left at whatever partial total had accumulated rather
   * than reset to 0.
   */
  pausedSkipped: number;
  /**
   * Present only when the drain stopped because one file was being claimed
   * repeatedly with no progress — see `runQueue`'s doc comment and
   * `DEFAULT_MAX_CLAIMS_PER_FILE`. Absent on every normal drain, including one
   * where a `held` file was legitimately re-claimed after its backoff expired.
   *
   * Its whole purpose is to turn "the run never came back" into a named file:
   * the counters above describe a drain that ended, and a drain that cannot
   * end has no counters at all.
   */
  repeatClaimStop?: RepeatClaimStop;
}

export interface RepeatClaimStop {
  fileId: string;
  path: string;
  /** Claims of this file id that this drain actually ran, before refusing another. */
  claims: number;
  /** How many of those ended `held`, i.e. recorded a real backoff. */
  backoffs: number;
  /** The absolute per-file ceiling in force for this drain. */
  limit: number;
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
  /**
   * Absolute ceiling on how many times ONE file id may be claimed within this
   * single drain. Defaults to `DEFAULT_MAX_CLAIMS_PER_FILE`. Lower it in a test
   * that wants to reach the ceiling; production has no reason to set it.
   */
  maxClaimsPerFile?: number;
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
  /**
   * Seam for tests: substitute the claim step (`claimNext`). Defaults to
   * the real `createMediaFileRepo(db).claimNext`; production code never
   * sets this. Exists so a test can force the CLAIM itself to throw (the
   * `SQLITE_BUSY` class of failure a concurrent writer can genuinely cause)
   * deterministically, without needing real database contention.
   */
  claimNextFn?: (input: {
    workerClass: string;
    nowMs: number;
    libraryIds?: string[];
  }) => ClaimedFile | null;
  /**
   * Seam for tests: substitute the read the post-drain `pausedSkipped`
   * tally uses (`listByLibrary`). Defaults to the real
   * `createMediaFileRepo(db).listByLibrary`; production code never sets
   * this. Exists so a test can force that tally to fail partway through
   * without needing real database contention.
   */
  listByLibraryFn?: (input: { libraryId: string; state?: FileState }) => MediaFileRow[];
}

/** Matches the value `runJob`'s own `buildArgs` call already hard-codes (see run-job.ts). */
const WORKER_CLASS = 'transcode';

/**
 * Absolute ceiling on claims of one file id within a single drain.
 *
 * The per-file allowance is normally derived from outcomes rather than from a
 * number — one claim, plus one more for each time the file ended `held`, since
 * ending `held` records a real backoff and is the only thing that legitimately
 * makes a file claimable again inside the same drain. This constant is the
 * backstop for the case where that derivation cannot help: a ledger whose
 * backoff never exhausts would buy itself one more claim for ever. Set above
 * the ledger's own `MAX_ATTEMPTS` so a healthy file can use every attempt it is
 * entitled to and still never reach it.
 */
export const DEFAULT_MAX_CLAIMS_PER_FILE = 8;

/**
 * Exhaustive on `FileState`: every member the type currently has gets an
 * explicit branch below, and this function's `never` parameter type means
 * adding a new `FileState` member without also adding a branch above is a
 * COMPILE ERROR here, not a silent fall-through. This is what makes the
 * `skipped === heldForRetry + notConverging` invariant hold by construction
 * rather than by every branch happening, today, to agree — the same
 * `satisfies Record<FileState, true>` discipline `media-file-repo.ts` uses
 * for `ALL_STATES_MAP`, applied to a switch instead of an object literal.
 */
const assertNever = (value: never): never => {
  throw new Error(`runQueue: unhandled FileState "${String(value)}" from runJob's result.`);
};

/**
 * Drain the queue, one file at a time, unattended: claim through the
 * atomic `claimNext`, run it to completion with `runJob`, fold the result
 * into a summary, and repeat — until `claimNext` finds nothing left to
 * claim, `maxFiles` claims have happened, `signal` aborts, or the claim
 * step itself fails. Sequential by design: worker classes and concurrency
 * caps are P2b (see the task brief); one worker converging a library
 * unattended is all this needs to do.
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
 * untouched backlog is once the drain ends, EXCLUDING anything this same
 * drain itself claimed before the library was paused (see its own doc
 * comment) — that file already has a real outcome recorded elsewhere in
 * the summary and must not be double-counted here.
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
 * directly, so nothing here needs to manage a process group either. One layer
 * down, `packages/engine/src/ffmpeg/run.ts` now spawns ffmpeg detached and
 * cancels by killing its whole process GROUP, so a plugin-spawned descendant
 * of ffmpeg dies with it — and the host's own SIGINT/SIGTERM/exit take those
 * groups down too, which is what a detached child costs. Whichever task wires
 * mid-file cancellation therefore only has to reach that abort signal; the
 * kill it triggers already covers the tree.
 *
 * THE FULL CONTRACT, made true by construction rather than by convention:
 * `runQueue` ALWAYS resolves with the summary so far; it never rejects.
 * Every fallible call inside the loop is individually guarded:
 *
 *  - Listing libraries + claiming (`libraryRepo.list()`, `claimNextFn`) —
 *    one `try`/`catch` around both, since computing the eligible-library
 *    filter is pointless without immediately using it to claim. A throw
 *    here (most concretely `SQLITE_BUSY` from a concurrent scanner or API
 *    write racing the claim UPDATE against the same WAL database) STOPS
 *    THE DRAIN — the loop breaks and returns the summary collected so far,
 *    the same as a natural "nothing left to claim". Deliberately not
 *    retried in place: a failing claim is evidence something is wrong with
 *    the database itself, not with one file, and spinning on it forever
 *    would turn a transient contention error into a hang. A caller that
 *    wants another attempt calls `runQueue` again (the same shape it
 *    already uses for "queue drained, come back later").
 *  - Running the claimed file (`runJobFn`) — its own `try`/`catch`; counts
 *    the file `failed` and `continue`s to the next claim (see
 *    `LoopSummary.failed`'s doc comment). Unlike a claim failure, a
 *    `runJob` failure says nothing about the database's health — the next
 *    file is still worth attempting.
 *  - Reading the row back for `onFile`'s path (`getById`) — guarded; falls
 *    back to the pre-run `claimed.path` rather than losing the outcome
 *    already computed above it.
 *  - The caller's `onFile` callback — guarded; a callback bug (a
 *    formatting error, closed stdout) must not cost the rest of the drain.
 *  - The post-loop `pausedSkipped` tally (`libraryRepo.list()` again, then
 *    `listByLibraryFn` per disabled library) — guarded per library, so one
 *    library's read failing does not erase the total already accumulated
 *    from libraries checked before it, and a total failure before any
 *    library is checked leaves `pausedSkipped` at 0 rather than throwing
 *    the whole summary away. This is the one place a throw would have been
 *    worst: a drain where every file already succeeded, discarded entirely
 *    for a failure in a tally that runs AFTER all the real work is done.
 *
 * NOTE: `maxFiles` bounds the number of CLAIMS, not the number of distinct
 * files. A file whose `held` backoff expires partway through a drain can be
 * claimed a second time in the same pass (after failing once, going back
 * through `claimNext`, and being picked up again before the loop stops) —
 * bounded by `MAX_ATTEMPTS` (3) at the ledger level, so not a liveness
 * bug, but `maxFiles: 10` does not always mean ten distinct files touched.
 *
 * WITHOUT `maxFiles` the drain is bounded only by `claimNext` running dry,
 * which is the correct loop and was also, once, a nine-minute spin: a
 * regression made converged files claimable again, and the same three files
 * were re-transcoded until the test suite gave up. That surfaced as a TIMEOUT
 * rather than a failure — the worst possible shape, since a drain that cannot
 * end produces no summary and names no file.
 *
 * So one file id may only be claimed as many times as its own outcomes justify:
 * once, plus once more for each time it ended `held`. Ending `held` is what
 * records a backoff, and a backoff is the only thing that legitimately makes a
 * file claimable again inside one drain — so "claimed again after a real
 * backoff" is normal and keeps working, while "claimed again having converged
 * (or been left `queued`) last time" means the drain is making no progress.
 * `DEFAULT_MAX_CLAIMS_PER_FILE` caps the allowance outright as a backstop for a
 * backoff that never exhausts. Reaching either stops the drain and reports
 * `LoopSummary.repeatClaimStop`, naming the file.
 *
 * The refused claim has already been committed as `running` by `claimNext`
 * before this loop can see it, so it is requeued rather than left stranded:
 * this loop refusing to run a file is not the file's fault, and `requeue` is
 * exactly the documented recovery for a row nothing is going to finish.
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
  const claimNextFn = input.claimNextFn ?? mediaFileRepo.claimNext;
  const listByLibraryFn = input.listByLibraryFn ?? mediaFileRepo.listByLibrary;

  const summary: LoopSummary = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    heldForRetry: 0,
    notConverging: 0,
    pausedSkipped: 0,
  };

  // Every fileId this drain itself claimed, regardless of outcome — used
  // only to keep the post-loop `pausedSkipped` tally from double-counting
  // a file that was claimed and worked on before its library was paused.
  const claimedThisDrain = new Set<string>();

  // Per file id: how many times this drain has claimed and run it, and how
  // many of those ended `held` (each of which authorises one further claim).
  const claimsPerFile = new Map<string, { claims: number; backoffs: number }>();
  const maxClaimsPerFile = input.maxClaimsPerFile ?? DEFAULT_MAX_CLAIMS_PER_FILE;

  for (;;) {
    if (input.signal?.aborted === true) break;
    if (input.maxFiles !== undefined && summary.claimed >= input.maxFiles) break;

    let claimed: ClaimedFile | null;
    try {
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

      claimed = claimNextFn({
        workerClass: WORKER_CLASS,
        nowMs: input.nowMs(),
        libraryIds: eligibleLibraryIds,
      });
    } catch {
      // See the doc comment above: a claim failure stops the drain rather
      // than spinning on it. Whatever the summary already holds is real
      // and is returned below exactly as if the queue had simply run dry.
      break;
    }
    if (claimed === null) break;

    // See the doc comment above. `1 + backoffs` is what this file's own
    // outcomes have earned; `maxClaimsPerFile` is the backstop for a backoff
    // that never exhausts.
    const history = claimsPerFile.get(claimed.fileId) ?? { claims: 0, backoffs: 0 };
    const allowance = Math.min(1 + history.backoffs, maxClaimsPerFile);
    if (history.claims >= allowance) {
      summary.repeatClaimStop = {
        fileId: claimed.fileId,
        path: claimed.path,
        claims: history.claims,
        backoffs: history.backoffs,
        limit: maxClaimsPerFile,
      };
      try {
        // `claimNext` committed `running` before returning it, and this loop is
        // not going to run it — so put it back rather than leave a row nothing
        // will finish.
        mediaFileRepo.requeue(claimed.fileId);
      } catch {
        // A failed requeue leaves the row `running` for `trawlarr reap`, which
        // is strictly better than losing the summary that explains the stop.
      }
      break;
    }
    claimsPerFile.set(claimed.fileId, { ...history, claims: history.claims + 1 });

    summary.claimed += 1;
    claimedThisDrain.add(claimed.fileId);

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

    switch (result.state) {
      case 'good':
        summary.succeeded += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'held': {
        summary.heldForRetry += 1;
        summary.skipped += 1;
        // A recorded backoff: this file may legitimately come back round once
        // its hold expires, even within this same drain.
        const held = claimsPerFile.get(claimed.fileId);
        if (held !== undefined) held.backoffs += 1;
        break;
      }
      case 'not_converging':
        summary.notConverging += 1;
        summary.skipped += 1;
        break;
      case 'unknown':
      case 'queued':
      case 'running':
        // Defensive: runJob's own applyRunOutcome/applyStall never resolve
        // a claimed file to one of these today, but FileState's union is
        // wider than what those two functions can currently produce. Routed
        // through `skipped` alone (no `heldForRetry`/`notConverging`
        // contribution, since neither describes it), which is exactly the
        // gap a future new FileState member would otherwise open silently
        // — see `assertNever` below and its doc comment.
        summary.skipped += 1;
        break;
      default:
        assertNever(result.state);
    }

    // The row may hold a NEW path by now (a container-changing replace
    // renames it) — `claimed.path` is only what it was BEFORE this run.
    // Reading it back from the row, rather than widening RunJobResult,
    // keeps run-job.ts untouched: this loop already knows how to ask for a
    // media file row by id. Guarded: a failed re-read must not erase the
    // outcome already folded into `summary` above — it just falls back to
    // the pre-run path.
    let finalPath = claimed.path;
    try {
      finalPath = mediaFileRepo.getById(claimed.fileId)?.path ?? claimed.path;
    } catch {
      // Keep the pre-run path.
    }

    try {
      input.onFile?.({ fileId: claimed.fileId, path: finalPath, state: result.state });
    } catch {
      // A caller's callback misbehaving (a formatting bug, closed stdout)
      // must not abort the drain either — the outcome above is already
      // recorded in `summary` and the database regardless of what the
      // callback does with it.
    }
  }

  // Guarded per library: one library's read failing must not erase the
  // total already accumulated from libraries checked before it, and this
  // whole block failing before it accumulates anything must not throw away
  // a summary that may already describe a drain where every file
  // succeeded — see the doc comment above.
  try {
    const pausedLibraries = libraryRepo.list().filter((library) => !library.enabled);
    for (const library of pausedLibraries) {
      try {
        const rows = [
          ...listByLibraryFn({ libraryId: library.id, state: 'queued' }),
          ...listByLibraryFn({ libraryId: library.id, state: 'held' }),
        ];
        for (const row of rows) {
          if (!claimedThisDrain.has(row.id)) summary.pausedSkipped += 1;
        }
      } catch {
        // Skip this library's contribution; keep the running total from
        // whichever libraries were already tallied.
      }
    }
  } catch {
    // libraryRepo.list() itself failed: pausedSkipped stays at whatever it
    // had reached (0, since nothing was tallied yet) rather than throwing.
  }

  return summary;
};
