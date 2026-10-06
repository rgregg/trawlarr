import { randomUUID } from 'node:crypto';
import { link, lstat, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { WORKING_FILE_PREFIX } from '@trawlarr/core';

/**
 * A note left beside the library file for the few milliseconds between
 * "the original moved to trash" and "the replacement is at its path".
 *
 * Replace Original File now finishes the copy BEFORE it trashes anything, so
 * that window is a pair of metadata operations rather than a multi-gigabyte
 * copy over NFS. It is not zero, though, and a worker killed inside it leaves
 * the library path empty with the original sitting in trash until retention
 * purges it — which is exactly how a film went missing on 2026-10-03. Nothing
 * on disk says which trash entry belongs to which path (the name is the
 * stem plus a timestamp, shared by every file with that basename), so the
 * intent is written down first and a later sweep reads it back.
 *
 * The name starts with {@link WORKING_FILE_PREFIX}, so the scanner and the
 * watcher never see it as media.
 */
export const SWAP_JOURNAL_PREFIX = `${WORKING_FILE_PREFIX}swap-`;

export const isSwapJournalName = (name: string): boolean =>
  name.startsWith(SWAP_JOURNAL_PREFIX) && name.endsWith('.json');

export interface SwapJournal {
  version: 1;
  /** The library path the original lived at. */
  originalPath: string;
  /** Where the replacement is to be installed (differs from `originalPath` on a container change). */
  finalPath: string;
  /** The complete copy beside `finalPath` that the install links into place. */
  stagedPath: string;
  trashDir: string;
  /** The timestamp the trash name was built from; see {@link findTrashedOriginal}. */
  trashNowMs: number;
  /** Identity of the original; a move preserves it, so it picks the right trash entry. */
  originalDev: number;
  originalIno: number;
}

export const journalPathFor = (finalPath: string): string =>
  join(dirname(finalPath), `${SWAP_JOURNAL_PREFIX}${randomUUID()}.json`);

export const writeSwapJournal = async (path: string, journal: SwapJournal): Promise<void> => {
  // `wx`: a name collision is a bug, never a reason to overwrite another swap's note.
  await writeFile(path, JSON.stringify(journal), { flag: 'wx' });
};

export const removeSwapJournal = async (path: string): Promise<void> => {
  await unlink(path).catch(() => {});
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The trash entry holding THIS original, or null.
 *
 * Trash names are `<stem>.<nowMs>[-n]<ext>`, and one trash directory serves a
 * whole library root, so the name alone can match another file's original.
 * The inode cannot: moving into trash preserves `(dev, ino)`.
 */
export const findTrashedOriginal = async (journal: SwapJournal): Promise<string | null> => {
  const extension = extname(journal.originalPath);
  const stem = basename(journal.originalPath, extension);
  const pattern = new RegExp(
    `^${escapeRegExp(stem)}\\.${String(journal.trashNowMs)}(-\\d+)?${escapeRegExp(extension)}$`,
  );
  let names: string[];
  try {
    names = await readdir(journal.trashDir);
  } catch {
    return null;
  }
  for (const name of names.filter((candidate) => pattern.test(candidate)).sort()) {
    const path = join(journal.trashDir, name);
    const stats = await lstat(path).catch(() => null);
    if (stats !== null && stats.dev === journal.originalDev && stats.ino === journal.originalIno) {
      return path;
    }
  }
  return null;
};

export type SwapRecovery =
  /** The note is unreadable or not ours; left alone. */
  | { outcome: 'invalid'; reason: string }
  /** The swap never started, was undone, or finished: nothing to repair. */
  | { outcome: 'settled'; detail: string }
  /** The original was in trash with its path empty, and is back. */
  | { outcome: 'restored'; restoredTo: string; from: string }
  /** The path is empty and the original cannot be found; kept for a human. */
  | { outcome: 'unrecoverable'; reason: string };

const exists = async (path: string): Promise<boolean> =>
  (await lstat(path).then(
    () => true,
    () => false,
  )) as boolean;

const parseJournal = (text: string): SwapJournal | null => {
  try {
    const value = JSON.parse(text) as Partial<SwapJournal>;
    if (
      value.version !== 1 ||
      typeof value.originalPath !== 'string' ||
      typeof value.finalPath !== 'string' ||
      typeof value.stagedPath !== 'string' ||
      typeof value.trashDir !== 'string' ||
      typeof value.trashNowMs !== 'number' ||
      typeof value.originalDev !== 'number' ||
      typeof value.originalIno !== 'number'
    ) {
      return null;
    }
    return value as SwapJournal;
  } catch {
    return null;
  }
};

/**
 * Repair a swap whose worker died. The CALLER must have established that no
 * live job can own it — this function cannot know, and restoring beneath a
 * running replacement would be two workers on one file.
 *
 * The rule is by what is on disk, not by what the note intended:
 *
 *  - the original's path or the final path is occupied: either the swap never
 *    got as far as trashing, was rolled back, or completed. Nothing is
 *    missing, so only the note is removed.
 *  - both are empty: the worker died between the trash move and the install.
 *    The ORIGINAL is restored rather than the new file installed. The ledger
 *    still describes the original, and a failed job must not leave a file at
 *    the path that no row ever recorded; the cost is encoding it again, the
 *    alternative's cost is a library whose rows and files disagree.
 *
 * The restore is exclusive (`link(2)` fails `EEXIST`), so a file that appeared
 * at the path in the meantime is never overwritten.
 */
export const recoverInterruptedSwap = async (journalPath: string): Promise<SwapRecovery> => {
  let text: string;
  try {
    text = await readFile(journalPath, 'utf8');
  } catch (error) {
    return { outcome: 'invalid', reason: `unreadable (${(error as Error).message})` };
  }
  const journal = parseJournal(text);
  if (journal === null) return { outcome: 'invalid', reason: 'not a swap journal' };

  if ((await exists(journal.originalPath)) || (await exists(journal.finalPath))) {
    await removeSwapJournal(journalPath);
    return { outcome: 'settled', detail: 'the library path is occupied; nothing is missing' };
  }

  const trashed = await findTrashedOriginal(journal);
  if (trashed === null) {
    return {
      outcome: 'unrecoverable',
      reason:
        `"${journal.originalPath}" is missing and its original is not in ` +
        `"${journal.trashDir}" (purged or moved by hand)`,
    };
  }

  try {
    await link(trashed, journal.originalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      await removeSwapJournal(journalPath);
      return { outcome: 'settled', detail: 'something took the path while recovering' };
    }
    // Hardlinks unavailable (SMB, FUSE): a plain rename, guarded by the same
    // existence check. Recovery runs one at a time in the sweep, with no live
    // job owning the directory, so there is no concurrent writer to race.
    if (
      code === undefined ||
      !['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EACCES'].includes(code)
    ) {
      return { outcome: 'unrecoverable', reason: `restoring from "${trashed}" failed: ${code}` };
    }
    if (await exists(journal.originalPath)) {
      await removeSwapJournal(journalPath);
      return { outcome: 'settled', detail: 'something took the path while recovering' };
    }
    try {
      await rename(trashed, journal.originalPath);
    } catch (renameError) {
      return {
        outcome: 'unrecoverable',
        reason: `restoring from "${trashed}" failed: ${(renameError as Error).message}`,
      };
    }
    await removeSwapJournal(journalPath);
    return { outcome: 'restored', restoredTo: journal.originalPath, from: trashed };
  }
  // Back at its own path; the trash name is now a second link, so drop it.
  await unlink(trashed).catch(() => {});
  await removeSwapJournal(journalPath);
  return { outcome: 'restored', restoredTo: journal.originalPath, from: trashed };
};
