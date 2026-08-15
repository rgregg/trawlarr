import type { FileState } from '@trawlarr/core';
import type { Db } from '../db/connection.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { runJob } from './run-job.js';

export interface LoopSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface RunQueueInput {
  db: Db;
  ffmpegPath: string;
  ffprobePath: string;
  nowMs: () => number;
  libraryIds?: string[];
  maxFiles?: number;
  signal?: AbortSignal;
  onFile?: (event: { fileId: string; path: string; state: FileState }) => void;
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
 * unwinding it afterwards.
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
 * `succeeded`/`failed`/`skipped` are a MECE split of every claimed file's
 * resulting `FileState`: `good` is `succeeded`, the terminal `failed` is
 * `failed`, and everything else (`held` — backed off for a later retry;
 * `not_converging` — the one-strike rule) is `skipped`: the run genuinely
 * happened, but the file was set aside rather than resolved either way.
 */
export const runQueue = async (input: RunQueueInput): Promise<LoopSummary> => {
  const mediaFileRepo = createMediaFileRepo(input.db);
  const libraryRepo = createLibraryRepo(input.db);

  const summary: LoopSummary = { claimed: 0, succeeded: 0, failed: 0, skipped: 0 };

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

    const result = await runJob({
      db: input.db,
      claimed,
      ffmpegPath: input.ffmpegPath,
      ffprobePath: input.ffprobePath,
      nowMs: input.nowMs,
    });

    if (result.state === 'good') summary.succeeded += 1;
    else if (result.state === 'failed') summary.failed += 1;
    else summary.skipped += 1;

    input.onFile?.({ fileId: claimed.fileId, path: claimed.path, state: result.state });
  }

  return summary;
};
