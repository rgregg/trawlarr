import { randomUUID } from 'node:crypto';
import { link, lstat, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from 'node:path';
import { WORKING_FILE_PREFIX } from '@trawlarr/core';
import { canonicalPath } from './encode-target.js';

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
    if (
      stats?.isFile() === true &&
      stats.dev === journal.originalDev &&
      stats.ino === journal.originalIno
    ) {
      return path;
    }
  }
  return null;
};

export type SwapRecovery =
  /** The note is unreadable, malformed or not ours; left alone, for a human. */
  | { outcome: 'invalid'; reason: string }
  /**
   * The note parsed but names something outside what this library owns, so
   * nothing was touched. A directory anyone with share access can write to is
   * not trusted to say where files should be moved.
   */
  | { outcome: 'refused'; reason: string }
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

const MAX_JOURNAL_BYTES = 16 * 1024;

const parseJournal = (text: string): SwapJournal | string => {
  let value: Partial<SwapJournal>;
  try {
    value = JSON.parse(text) as Partial<SwapJournal>;
  } catch (error) {
    return `not valid JSON (${(error as Error).message})`;
  }
  if (typeof value !== 'object' || value === null) return 'not a JSON object';
  if (
    value.version !== 1 ||
    typeof value.originalPath !== 'string' ||
    typeof value.finalPath !== 'string' ||
    typeof value.stagedPath !== 'string' ||
    typeof value.trashDir !== 'string' ||
    !Number.isSafeInteger(value.trashNowMs) ||
    typeof value.originalDev !== 'number' ||
    typeof value.originalIno !== 'number'
  ) {
    return 'missing or mistyped fields';
  }
  return value as SwapJournal;
};

/** What a journal may name: the library's own roots, and its configured trash. */
export interface SwapRecoveryScope {
  /** The library roots every path in the note must lie inside. */
  roots: readonly string[];
  /** Trash directories outside the roots that the library is configured to use. */
  trashDirs?: readonly string[];
}

const isInside = (parent: string, child: string): boolean => {
  const base = canonicalPath(parent);
  // The PARENT is canonicalised and the name appended: a path that does not exist yet
  // (the original, mid-swap) cannot be realpath-ed, and falling back to a lexical
  // resolve would let a symlinked parent directory walk straight out of the root.
  const target = join(canonicalPath(dirname(child)), basename(child));
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
};

/** Absolute, already normalized, no NUL, no `..` segment: spelled exactly as it is meant. */
const cleanAbsolute = (path: string): boolean =>
  isAbsolute(path) &&
  !path.includes('\0') &&
  normalize(path) === path &&
  !path.split(sep).includes('..');

/**
 * Every path read back from a note is untrusted: the library directory can be
 * written by anyone with access to the share, and the note drives a link and
 * an unlink. Returns why it is refused, or null.
 *
 *  - every path is clean (see {@link cleanAbsolute}) and canonically inside a
 *    library root, trash inside a root or a configured trash directory — the
 *    canonical form follows symlinks, so a link planted inside a root that
 *    points out of it does not pass;
 *  - the note lives beside the file it is about, the original and the final
 *    path share that directory, and the staged name is the replace step's own.
 *    A note copied or planted elsewhere does not describe a swap that happened
 *    here.
 */
const refusalFor = (
  journal: SwapJournal,
  journalPath: string,
  scope: SwapRecoveryScope,
): string | null => {
  for (const [label, path] of [
    ['originalPath', journal.originalPath],
    ['finalPath', journal.finalPath],
    ['stagedPath', journal.stagedPath],
    ['trashDir', journal.trashDir],
  ] as const) {
    if (!cleanAbsolute(path)) return `${label} "${path}" is not a clean absolute path`;
  }
  const inRoots = (path: string): boolean => scope.roots.some((root) => isInside(root, path));
  for (const [label, path] of [
    ['originalPath', journal.originalPath],
    ['finalPath', journal.finalPath],
    ['stagedPath', journal.stagedPath],
  ] as const) {
    if (!inRoots(path)) return `${label} "${path}" is outside the library roots`;
  }
  if (
    !inRoots(journal.trashDir) &&
    !(scope.trashDirs ?? []).some((d) => isInside(d, journal.trashDir))
  ) {
    return `trashDir "${journal.trashDir}" is not inside the library roots or its configured trash`;
  }
  const dir = dirname(journal.finalPath);
  if (dirname(journal.originalPath) !== dir || dirname(journal.stagedPath) !== dir) {
    return 'the original, final and staged paths are not in one directory';
  }
  if (canonicalPath(dirname(journalPath)) !== canonicalPath(dir)) {
    return `the note is not in "${dir}", the directory it describes`;
  }
  if (!basename(journal.stagedPath).startsWith(`${WORKING_FILE_PREFIX}replace-`)) {
    return `stagedPath "${journal.stagedPath}" is not a replace-step temp name`;
  }
  return null;
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
export const recoverInterruptedSwap = async (
  journalPath: string,
  scope: SwapRecoveryScope,
): Promise<SwapRecovery> => {
  if (!isSwapJournalName(basename(journalPath))) {
    return { outcome: 'invalid', reason: 'not named like a swap note' };
  }
  let text: string;
  try {
    const stats = await lstat(journalPath);
    if (!stats.isFile() || stats.size > MAX_JOURNAL_BYTES) {
      return { outcome: 'invalid', reason: 'not a small regular file' };
    }
    text = await readFile(journalPath, 'utf8');
  } catch (error) {
    return { outcome: 'invalid', reason: `unreadable (${(error as Error).message})` };
  }
  const parsed = parseJournal(text);
  if (typeof parsed === 'string') return { outcome: 'invalid', reason: parsed };
  const journal = parsed;
  const refusal = refusalFor(journal, journalPath, scope);
  if (refusal !== null) return { outcome: 'refused', reason: refusal };

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
