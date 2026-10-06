import { lstat, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { isWorkingFileName } from '@trawlarr/core';
import { isSwapJournalName, recoverInterruptedSwap } from '@trawlarr/engine';
import type { Db } from '../db/connection.js';
import { canonicalPath, pathContains } from '../fs/path-contains.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a scratch file in a library directory must have gone unmodified
 * before it can be removed, once nothing could own it.
 *
 * A day, for the reason `DEFAULT_STALE_AFTER_MS` (the stalled-row reaper) is:
 * "untouched" has to outlast the longest thing a live worker legitimately does
 * without writing, and a heartbeat only advances between flow steps. The
 * ownership test below is what normally decides; this floor covers whatever it
 * cannot see (a hung copy on a dead NFS mount writes nothing for hours).
 */
export const DEFAULT_WORKING_FILE_STALE_AFTER_MS = 24 * HOUR_MS;

/**
 * A swap note younger than this is never acted on. A swap's whole window is a
 * pair of metadata operations and its job row is open throughout, so this is
 * belt and braces against a writer with no job row.
 */
const MIN_JOURNAL_AGE_MS = 10 * 60 * 1000;

export interface WorkingFileSweepSummary {
  /** Scratch files and swap notes examined. */
  examined: number;
  /** Orphaned scratch files removed (or, under `dryRun`, that would have been). */
  removed: number;
  /** Left because a running job could own them, or because they are too recent. */
  retained: number;
  /** Interrupted swaps whose original was put back from trash. */
  swapsRestored: number;
  /** Swap notes needing a human: the path is empty and the original cannot be found. */
  swapsUnrecoverable: number;
  /** Swap notes that were malformed or named paths outside the library; left in place. */
  swapsRefused: number;
  /** Removals or recoveries that failed. */
  failed: number;
}

export interface SweepWorkingFilesInput {
  db: Db;
  libraryId: string;
  /** Every `.trawlarr-*` FILE a COMPLETED walk of the library came across. */
  files: readonly string[];
  /** The library's roots: nothing outside them is ever removed or moved. */
  roots: readonly string[];
  /** Configured trash directories outside the roots. */
  trashDirs?: readonly string[];
  nowMs: number;
  staleAfterMs?: number;
  dryRun?: boolean;
  /** Seam for tests; reports what happened to one file. */
  onEvent?: (message: string) => void;
}

/**
 * Directories in which a job could be writing scratch files right now.
 *
 * Replace Original File writes its temp, its reservation and its swap note
 * beside the file it replaces, so a job owns the directory of the file it
 * holds. Both signals are read because neither alone is complete: a claim
 * commits `running` on the row BEFORE the job row exists, and a job row stays
 * open (`ended_at IS NULL`) for as long as its worker — local or on a node, a
 * leased remote job included — is alive or has not been reaped. The reaper's
 * 24 h floor applies to both, so a long step is never mistaken for a dead
 * worker here either.
 */
const ownedDirectories = (db: Db, libraryId: string): Set<string> => {
  const rows = [
    ...(db
      .prepare(`SELECT path FROM media_file WHERE library_id = ? AND state = 'running'`)
      .all(libraryId) as { path: string }[]),
    ...(db
      .prepare(
        `SELECT m.path AS path FROM job j JOIN media_file m ON m.id = j.file_id
         WHERE j.ended_at IS NULL AND m.library_id = ?`,
      )
      .all(libraryId) as { path: string }[]),
  ];
  return new Set(rows.map((row) => canonicalPath(dirname(row.path))));
};

/**
 * Clean up after workers that died mid-replacement, and repair the one swap
 * state that loses a file.
 *
 * WHY THIS IS IN THE SCAN. The scan's walk already visits every directory of
 * the library and sees these files (it skips them by name, see `walkFiles`);
 * a separate sweep would walk a network mount a second time to find them.
 * Doing it only after a walk that RAN TO COMPLETION means an unmounted root,
 * which yields an empty walk, produces no candidates at all.
 *
 * WHAT IT WILL REMOVE. Only names the replace step itself makes
 * (`.trawlarr-replace-*`, `.trawlarr-reserve-*`), and only when BOTH hold:
 *
 *  - no job could own the directory (see {@link ownedDirectories}), and
 *  - the file has not been modified for `staleAfterMs`.
 *
 * Anything else with the prefix — a name from a later version, a user's own
 * file that happens to start `.trawlarr-` — is left alone.
 *
 * WHAT IT WILL REPAIR. A swap note (`.trawlarr-swap-*.json`) whose directory no
 * job owns. If the library path is empty and the original is in trash, the
 * original is restored (see `recoverInterruptedSwap`); this does not wait for
 * the age floor, because an empty library path is the harm and trash retention
 * is the clock running out on it. Notes are processed before scratch files so
 * the staged copy outlives a failed repair.
 */
export const sweepWorkingFiles = async (
  input: SweepWorkingFilesInput,
): Promise<WorkingFileSweepSummary> => {
  const summary: WorkingFileSweepSummary = {
    examined: 0,
    removed: 0,
    retained: 0,
    swapsRestored: 0,
    swapsUnrecoverable: 0,
    swapsRefused: 0,
    failed: 0,
  };
  if (input.files.length === 0) return summary;

  const owned = ownedDirectories(input.db, input.libraryId);
  const say = (message: string): void => input.onEvent?.(message);

  /**
   * The one place a candidate becomes something that may be acted on, and the
   * path it returns is the path every later check AND the unlink use. The
   * directory is resolved through symlinks first, so a link planted inside the
   * library that points outside it fails containment, and the ownership test
   * compares real directories rather than two spellings of one.
   */
  const resolveCandidate = async (
    path: string,
    kind: 'scratch' | 'journal',
  ): Promise<{ target: string; dir: string } | null> => {
    const name = basename(path);
    const nameOk =
      isWorkingFileName(name) &&
      (kind === 'journal'
        ? isSwapJournalName(name)
        : name.startsWith('.trawlarr-replace-') || name.startsWith('.trawlarr-reserve-'));
    if (!nameOk || !isAbsolute(path) || normalize(path) !== path) return null;
    let dir: string;
    try {
      dir = await realpath(dirname(path));
    } catch {
      return null;
    }
    if (!input.roots.some((root) => pathContains(root, dir))) {
      say(`Ignoring "${path}": it is not inside this library's roots.`);
      return null;
    }
    return { target: join(dir, name), dir };
  };
  const ownedNow = (dir: string): boolean => ownedDirectories(input.db, input.libraryId).has(dir);

  for (const path of input.files.filter((file) => isSwapJournalName(basename(file)))) {
    const candidate = await resolveCandidate(path, 'journal');
    if (candidate === null) continue;
    summary.examined += 1;
    const stats = await lstat(candidate.target).catch(() => null);
    if (stats === null) continue;
    if (ownedNow(candidate.dir) || input.nowMs - stats.mtimeMs < MIN_JOURNAL_AGE_MS) {
      summary.retained += 1;
      continue;
    }
    if (input.dryRun === true) continue;
    try {
      const result = await recoverInterruptedSwap(candidate.target, {
        roots: input.roots,
        trashDirs: input.trashDirs,
      });
      if (result.outcome === 'restored') {
        summary.swapsRestored += 1;
        say(`Restored "${result.restoredTo}" from trash after an interrupted replacement.`);
      } else if (result.outcome === 'unrecoverable') {
        summary.swapsUnrecoverable += 1;
        say(`Interrupted replacement at "${path}" needs a human: ${result.reason}.`);
      } else if (result.outcome === 'refused' || result.outcome === 'invalid') {
        // Never a silent "nothing to recover": a note that cannot be trusted
        // or read is left in place and reported on every pass.
        summary.swapsRefused += 1;
        say(`Swap note "${path}" was not acted on (${result.outcome}): ${result.reason}.`);
      }
    } catch {
      summary.failed += 1;
    }
  }

  for (const path of input.files) {
    const name = basename(path);
    if (isSwapJournalName(name)) continue;
    const candidate = await resolveCandidate(path, 'scratch');
    if (candidate === null) continue;
    summary.examined += 1;
    const stats = await lstat(candidate.target).catch(() => null);
    // A symlink or directory named like scratch is not scratch.
    if (stats === null || !stats.isFile()) continue;
    if (ownedNow(candidate.dir) || input.nowMs - stats.mtimeMs < staleAfterMs) {
      summary.retained += 1;
      continue;
    }
    if (input.dryRun !== true) {
      try {
        // Same resolved path that every check above used, re-examined at the
        // last moment: still a regular file, still unowned.
        const again = await lstat(candidate.target);
        if (!again.isFile() || ownedNow(candidate.dir) || again.mtimeMs !== stats.mtimeMs) {
          summary.retained += 1;
          continue;
        }
        await unlink(candidate.target);
      } catch {
        summary.failed += 1;
        continue;
      }
    }
    summary.removed += 1;
    say(`Removed orphaned working file "${candidate.target}".`);
  }

  return summary;
};
