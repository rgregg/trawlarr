import { lstat, opendir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Db } from '../db/connection.js';
import { createJobRepo } from '../db/job-repo.js';
import type { LibraryRecord } from '../db/library-repo.js';
import { canonicalPath, pathContains } from '../fs/path-contains.js';
import { RESERVED_DIR_NAME } from './paths.js';
import { WORK_DIR_PREFIX, jobIdFromWorkDirName } from './staging-dir.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a scratch directory WHOSE OWNER CANNOT BE IDENTIFIED must have
 * gone untouched before it is removed.
 *
 * Deliberately the same day as `DEFAULT_STALE_AFTER_MS`, and for the same
 * reason: "untouched" has to be longer than the longest thing a live run
 * legitimately does without writing, and one flow step is a whole transcode.
 * It applies only to the fallback rule below — a directory whose name
 * carries a job id is decided by the database, not by a clock.
 */
export const DEFAULT_STAGING_STALE_AFTER_MS = 24 * HOUR_MS;

/** Every staging directory this library's runs could have staged into. */
export const stagingDirsForLibrary = (library: LibraryRecord): string[] => {
  if (library.stagingDir !== null) return [resolve(library.stagingDir)];
  return [
    ...new Set(library.roots.map((root) => join(resolve(root), RESERVED_DIR_NAME, 'staging'))),
  ];
};

export interface StagingSweepSummary {
  /** Staging directories actually examined. */
  dirsSwept: number;
  /** Staging directories that do not exist yet — nothing has been staged there. */
  dirsMissing: number;
  /** Staging directories refused as unsafe to sweep (see `sweepStaging`). */
  dirsRefused: number;
  /** Scratch directories removed (or, under `dryRun`, that would have been). */
  removed: number;
  /**
   * Bytes in the regular files directly inside the removed directories.
   *
   * Directly inside, not recursively: a run's scratch directory holds its
   * encode outputs as flat files, and walking a tree that may sit on a
   * network mount to improve a reporting number is not worth the round
   * trips. Under-reporting here is a report that is smaller than the truth,
   * never a directory that is deleted on the strength of it.
   */
  bytesFreed: number;
  /** Directories left because a live run owns them, or because they are too recent. */
  retained: number;
  /** Entries left alone because they are not a run's scratch directory. */
  skipped: number;
  /** Directories this sweep tried to remove and could not. */
  failed: number;
}

export interface SweepStagingInput {
  db: Db;
  library: LibraryRecord;
  nowMs: number;
  /** Override {@link DEFAULT_STAGING_STALE_AFTER_MS} for this sweep only. */
  staleAfterMs?: number;
  /** Report what would go, remove nothing. */
  dryRun?: boolean;
}

/** What one entry of a staging directory should have done to it. */
type Verdict = 'remove' | 'retain' | 'skip';

/**
 * Newest modification time anywhere in `dirPath` at one level, and the bytes
 * its regular files hold.
 *
 * The DIRECTORY's own mtime is not enough on its own and is deliberately not
 * used alone: a directory's mtime moves when an entry is created or removed,
 * not while a file inside it is being written. An eight-hour encode creates
 * its output file in the first second and then writes into it for eight
 * hours, so the directory would age as if nothing were happening. The
 * entries' own mtimes are what actually advance while ffmpeg runs, so the
 * newest of the two is the signal.
 */
const surveyDir = async (
  dirPath: string,
): Promise<{ newestMtimeMs: number; bytes: number } | null> => {
  let stats;
  try {
    stats = await lstat(dirPath);
  } catch {
    return null;
  }
  let newestMtimeMs = stats.mtimeMs;
  let bytes = 0;

  let dir;
  try {
    dir = await opendir(dirPath);
  } catch {
    // Unreadable. Reporting the directory's own mtime is the conservative
    // answer: it can only make the directory look OLDER than it is, which
    // is the direction that deletes, so the caller must not act on this
    // alone — and it does not: an unreadable directory cannot be removed
    // either, and the attempt is counted as a failure.
    return { newestMtimeMs, bytes };
  }
  try {
    for await (const entry of dir) {
      let entryStats;
      try {
        entryStats = await lstat(join(dirPath, entry.name));
      } catch {
        continue;
      }
      newestMtimeMs = Math.max(newestMtimeMs, entryStats.mtimeMs);
      if (entryStats.isFile()) bytes += entryStats.size;
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return { newestMtimeMs, bytes };
};

/**
 * Remove the scratch directories of runs that are over, and NEVER the
 * scratch directory of a run that is not.
 *
 * WHY A LEAKED DIRECTORY EXISTS AT ALL. `runPayload` removes its own
 * scratch directory when it finishes, in a `finally` that covers every
 * ending it can observe — but not the endings it cannot: a SIGKILL from the
 * OOM killer, a segfault in a native module, the host losing power. A worker
 * that dies that way leaves its partial encode behind, and on a library
 * whose staging directory sits on the media filesystem (the default: it must
 * be, so installing the result is an atomic rename) that is the user's own
 * disk filling up with files nothing will ever look at again. Nothing in
 * this tree removed them before this function existed.
 *
 * WHY A LIVE RUN'S DIRECTORY IS NEVER SWEPT. The safety argument is about
 * IDENTITY, not age, and this is the whole reason `workDirPrefix` puts the
 * job id in the directory's name:
 *
 *  1. A directory whose name carries a job id that names a job row with
 *     `ended_at IS NULL` is RETAINED, whatever its age and whatever its
 *     mtimes say. That row is written before the worker is forked
 *     (`startWorker` inserts it, then creates the agent) and is cleared only
 *     once the run's outcome has been folded in, so the window in which a
 *     live run's directory exists is strictly INSIDE the window in which its
 *     job row is unfinished. Deleting under a live encode is therefore not
 *     "unlikely", it is unreachable: there is no interleaving in which the
 *     directory is on disk and the row is not open, because the directory is
 *     created by the process the row already describes.
 *  2. A directory whose job row has ENDED is removed. Its owner has reported
 *     (or been reclaimed, or been recorded as vanished) and can never write
 *     into it again — `runPayload` does all of its work before it returns
 *     the report that ends the row.
 *  3. A directory whose owner cannot be identified — a name from a build
 *     that predates job ids, a `trawlarr run` that had no job row, a job
 *     whose history has been pruned — falls back to the AGE rule, and only
 *     that case does. It needs a full `staleAfterMs` of no modification
 *     anywhere in the directory, measured against the newest mtime of the
 *     directory AND its entries (see `surveyDir`), which is a signal that
 *     advances while an encode writes.
 *
 * Two further containments, both borrowed from `purgeTrash`: a staging
 * directory that CONTAINS a library root is refused outright (removing
 * things inside it would be removing the library), and every entry is
 * canonicalised, so a symlink pointing out of the directory fails the
 * containment check and is never followed. Only entries that are real
 * directories named `trawlarr-job-*` are ever candidates; anything else a
 * user or another program left in there is skipped, never removed.
 */
export const sweepStaging = async (input: SweepStagingInput): Promise<StagingSweepSummary> => {
  const summary: StagingSweepSummary = {
    dirsSwept: 0,
    dirsMissing: 0,
    dirsRefused: 0,
    removed: 0,
    bytesFreed: 0,
    retained: 0,
    skipped: 0,
    failed: 0,
  };
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STAGING_STALE_AFTER_MS;
  const jobRepo = createJobRepo(input.db);

  for (const stagingDir of stagingDirsForLibrary(input.library)) {
    const canonicalDir = canonicalPath(stagingDir);

    if (input.library.roots.some((root) => pathContains(canonicalDir, root))) {
      summary.dirsRefused += 1;
      continue;
    }

    let dir;
    try {
      dir = await opendir(canonicalDir);
    } catch {
      summary.dirsMissing += 1;
      continue;
    }
    summary.dirsSwept += 1;

    // Collected first, then acted on: removing entries while iterating an
    // open directory handle is exactly the pattern that makes a walk skip
    // entries on some filesystems.
    const candidates: string[] = [];
    try {
      for await (const entry of dir) {
        const entryPath = join(canonicalDir, entry.name);
        if (!entry.name.startsWith(WORK_DIR_PREFIX) || !pathContains(canonicalDir, entryPath)) {
          summary.skipped += 1;
          continue;
        }
        let stats;
        try {
          stats = await lstat(entryPath);
        } catch {
          summary.skipped += 1;
          continue;
        }
        // A symlink is never followed and a stray file named like a scratch
        // directory is not one.
        if (!stats.isDirectory()) {
          summary.skipped += 1;
          continue;
        }
        candidates.push(entry.name);
      }
    } finally {
      await dir.close().catch(() => {});
    }

    for (const name of candidates) {
      const entryPath = join(canonicalDir, name);
      const jobId = jobIdFromWorkDirName(name);
      const job = jobId === null ? null : jobRepo.getById(jobId);

      let verdict: Verdict;
      let bytes = 0;
      if (job !== null) {
        // RULE 1 AND 2: the database owns this decision. No clock involved.
        verdict = job.endedAt === null ? 'retain' : 'remove';
        if (verdict === 'remove') bytes = (await surveyDir(entryPath))?.bytes ?? 0;
      } else {
        // RULE 3: nobody claims it, so age is all there is.
        const survey = await surveyDir(entryPath);
        if (survey === null) {
          summary.skipped += 1;
          continue;
        }
        verdict = input.nowMs - survey.newestMtimeMs > staleAfterMs ? 'remove' : 'retain';
        bytes = survey.bytes;
      }

      if (verdict === 'retain') {
        summary.retained += 1;
        continue;
      }
      if (input.dryRun === true) {
        summary.removed += 1;
        summary.bytesFreed += bytes;
        continue;
      }
      try {
        await rm(entryPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        summary.removed += 1;
        summary.bytesFreed += bytes;
      } catch {
        // One undeletable directory must not stop the rest of the sweep.
        summary.failed += 1;
      }
    }
  }

  return summary;
};

export interface LibraryStagingSweep {
  libraryId: string;
  libraryName: string;
  dryRun: boolean;
  summary: StagingSweepSummary;
}

/**
 * Sweep one library's staging directories, shaped like `sweepLibraryTrash`
 * so the daemon's periodic maintenance treats the two the same way.
 */
export const sweepLibraryStaging = async (
  input: SweepStagingInput,
): Promise<LibraryStagingSweep> => ({
  libraryId: input.library.id,
  libraryName: input.library.name,
  dryRun: input.dryRun === true,
  summary: await sweepStaging(input),
});
