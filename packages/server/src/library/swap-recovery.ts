import { link, lstat, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';
import { inodeKeyOf } from '@trawlarr/core';
import { trashEntryPattern } from '@trawlarr/engine';
import type { Db } from '../db/connection.js';
import { createJobRepo } from '../db/job-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { readSwapNote, swapNotesDir } from '../worker/swap-note.js';
import { resolveTrashDir } from './paths.js';

export interface SwapRecoverySummary {
  /** Notes examined. */
  examined: number;
  /** Originals put back from trash. */
  restored: number;
  /** Notes whose swap needed nothing (the library path is occupied); removed. */
  settled: number;
  /** Notes left because a job could still own them. */
  retained: number;
  /** Notes that were not acted on, for a reason that is logged; left in place. */
  refused: number;
}

export interface RecoverSwapsInput {
  db: Db;
  dataDir: string;
  /** Reports each outcome that needs a human or changed a file. */
  onEvent?: (message: string) => void;
  /** Seam for tests: runs between the checks and the first change. */
  beforeUse?: () => Promise<void>;
}

const JOB_ID_NOTE = /^([A-Za-z0-9_-]{1,64})\.json$/;

const within = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * `path` with every symlink resolved, even when its tail does not exist: the
 * deepest ancestor that exists is `realpath`ed and the rest appended.
 */
const resolveDeepest = async (path: string): Promise<string> => {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || dirname(current) === current) throw error;
      tail.push(basename(current));
      current = dirname(current);
    }
  }
};

/**
 * Put back an original whose swap was interrupted: a worker died after moving
 * it to trash and before installing its replacement, leaving the library path
 * empty (the loss of 2026-10-03, before the copy was moved ahead of the trash
 * move; what remains is a window of two metadata operations).
 *
 * TRUST BOUNDARY. A note says only that job `<id>` reached the trash step and
 * the timestamp its trash name carries. It is read from the daemon's own data
 * directory, which is not writable from the share. Every PATH comes from the
 * database: the job gives the file row, the row gives the original's path (the
 * ledger's record of where the file was before the run) and its library, the
 * library gives its trash directory. Nothing found in a library, staging or
 * trash directory names anywhere to act on, so tampering with files there
 * cannot steer this.
 *
 * WHEN IT ACTS. Only for a job that has ENDED (the reaper closes a dead
 * worker's row first, so this runs after it); an open job may be mid-swap and
 * restoring beneath it would be two workers on one file. Then by what is on
 * disk:
 *
 *  - the original's path, or a sibling with the same stem and a library
 *    extension (a container change installs `movie.mp4` for `movie.mkv`), is
 *    occupied: the swap never trashed, was undone, or finished. Only the note
 *    is removed.
 *  - otherwise the original is looked up in the library's trash directory by
 *    the name the swap gave it and by identity (device and inode must equal the
 *    row's `inode_key`; a move preserves them) and linked back exclusively.
 *    Not found, or not provably the same file: refused and logged, the note
 *    kept. The original, not the new file, is restored so the ledger and the
 *    disk agree; the cost is encoding it again.
 *
 * CHECK, THEN USE. Node cannot do `openat2(RESOLVE_NO_SYMLINKS)` or `linkat`
 * on a directory handle, so the kernel re-resolves every path when it is used.
 * Defence in depth: everything acts on the RESOLVED, root-contained form;
 * immediately before the link the directory and trash entry are examined
 * again; after it, the new name must be the same inode and the directory the
 * same, else the link this call made is removed (only if it is that inode) and
 * the recovery is refused. The remaining window is between that last look and
 * `link(2)` itself: microseconds, and only for someone who can already write
 * in the library directory.
 */
export const recoverInterruptedSwaps = async (
  input: RecoverSwapsInput,
): Promise<SwapRecoverySummary> => {
  const summary: SwapRecoverySummary = {
    examined: 0,
    restored: 0,
    settled: 0,
    retained: 0,
    refused: 0,
  };
  const say = (message: string): void => input.onEvent?.(message);
  const jobs = createJobRepo(input.db);
  const files = createMediaFileRepo(input.db);
  const libraries = createLibraryRepo(input.db);

  let names: string[];
  try {
    names = await readdir(swapNotesDir(input.dataDir));
  } catch {
    return summary;
  }

  for (const name of names) {
    const match = JOB_ID_NOTE.exec(name);
    if (match === null) continue;
    summary.examined += 1;
    const jobId = match[1]!;
    const notePath = join(swapNotesDir(input.dataDir), name);
    const refuse = (reason: string): void => {
      summary.refused += 1;
      say(`Swap note for job ${jobId} was not acted on: ${reason}.`);
    };

    const job = jobs.getById(jobId);
    if (job === null) {
      refuse('no such job in the database');
      continue;
    }
    // `ended_at` is set by every way a job ends: finished, failed, cancelled,
    // closed by the reaper (a dead local worker, or a node's lease running
    // out). An open job, leased or not, may be mid-swap right now.
    if (job.endedAt === null) {
      summary.retained += 1;
      continue;
    }
    // An ended job is not enough on its own: the file may have been claimed
    // AGAIN since, by a newer job whose worker is live. Restoring beneath it is
    // two workers on one file.
    if (
      files.getById(job.fileId)?.state === 'running' ||
      jobs.listForFile(job.fileId).some((other) => other.endedAt === null)
    ) {
      summary.retained += 1;
      continue;
    }
    const note = await readSwapNote(notePath);
    if ('error' in note) {
      refuse(note.error);
      continue;
    }
    const row = files.getById(job.fileId);
    const library = row === null ? null : libraries.getById(row.library_id);
    if (row === null || library === null) {
      refuse('its file or library is no longer in the database');
      continue;
    }

    try {
      const originalPath = row.path;
      const dir = await resolveDeepest(dirname(originalPath));
      const roots = await Promise.all(library.roots.map(resolveDeepest));
      if (!roots.some((root) => within(root, dir))) {
        refuse(`"${originalPath}" is not inside the library's roots`);
        continue;
      }

      // Is anything at the original's path? Only a REGULAR FILE there means
      // nothing is missing; a directory, symlink or anything else is not the
      // original and not something to settle on.
      const here = await lstat(join(dir, basename(originalPath))).catch(() => null);
      if (here !== null) {
        if (!here.isFile()) {
          refuse(`"${originalPath}" is occupied by something that is not a regular file`);
          continue;
        }
        await unlink(notePath).catch(() => {});
        summary.settled += 1;
        continue;
      }
      // A sibling with the same stem may be the replacement installed under a
      // new container, or a different title, a partial download, a directory.
      // Nothing recorded can tell which (a crash leaves no post-run path in the
      // database), so it is never taken as the replacement: refuse and keep the
      // note. The original stays in trash for its retention; a human decides.
      const stem = basename(originalPath, extname(originalPath));
      const siblings = (await readdir(dir)).filter(
        (entry) =>
          // The WHOLE stem, not a prefix of it: `Film.Trailer.mkv` beside
          // `Film.mkv` is a companion, and taking it for a candidate refused
          // the restore in every folder that keeps a trailer or a sample.
          basename(entry, extname(entry)) === stem &&
          !entry.startsWith('.trawlarr-') &&
          library.extensions.includes(extname(entry).slice(1).toLowerCase()),
      );
      if (siblings.length > 0) {
        refuse(
          `"${originalPath}" is gone but "${siblings.join('", "')}" is beside it; whether that ` +
            `is the replacement cannot be established, so nothing was restored or removed`,
        );
        continue;
      }

      if (row.inode_key === null) {
        refuse('the row records no inode, so the original cannot be identified in trash');
        continue;
      }
      const trashDir = await resolveDeepest(resolveTrashDir({ library, filePath: originalPath }));
      const pattern = trashEntryPattern({
        originalName: basename(originalPath),
        nowMs: note.trashNowMs,
      });
      let trashed: { path: string; dev: number; ino: number } | null = null;
      for (const entry of (await readdir(trashDir).catch(() => [])).filter((e) =>
        pattern.test(e),
      )) {
        const stats = await lstat(join(trashDir, entry)).catch(() => null);
        if (stats?.isFile() === true && inodeKeyOf(stats.dev, stats.ino) === row.inode_key) {
          trashed = { path: join(trashDir, entry), dev: stats.dev, ino: stats.ino };
          break;
        }
      }
      if (trashed === null) {
        refuse(
          `the original is not in "${trashDir}" under the name the swap gave it (purged, or ` +
            `moved by hand)`,
        );
        continue;
      }

      await input.beforeUse?.();

      const target = join(dir, basename(originalPath));
      const dirNow = await resolveDeepest(dirname(originalPath)).catch(() => null);
      const trashedNow = await lstat(trashed.path).catch(() => null);
      if (
        dirNow !== dir ||
        trashedNow === null ||
        !trashedNow.isFile() ||
        trashedNow.dev !== trashed.dev ||
        trashedNow.ino !== trashed.ino
      ) {
        refuse('the library changed while the note was being checked');
        continue;
      }

      let renamed = false;
      try {
        await link(trashed.path, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          await unlink(notePath).catch(() => {});
          summary.settled += 1;
          continue;
        }
        // Hardlinks unavailable (SMB, FUSE): a rename, guarded by the same
        // existence check.
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EACCES'].includes(code ?? '')) {
          refuse(`restoring failed (${code ?? String(error)})`);
          continue;
        }
        if (
          await lstat(target).then(
            () => true,
            () => false,
          )
        ) {
          await unlink(notePath).catch(() => {});
          summary.settled += 1;
          continue;
        }
        await rename(trashed.path, target);
        renamed = true;
      }

      const created = await lstat(target).catch(() => null);
      const dirAfter = await resolveDeepest(dirname(originalPath)).catch(() => null);
      const ours =
        created?.isFile() === true &&
        created.dev === trashed.dev &&
        created.ino === trashed.ino &&
        dirAfter === dir;
      if (!ours) {
        // Remove the name this call made only if it is the very inode it
        // linked there, never something put in its place.
        if (created !== null && created.dev === trashed.dev && created.ino === trashed.ino) {
          await unlink(target).catch(() => {});
        }
        refuse('the path changed while the original was being restored');
        continue;
      }
      if (!renamed) await unlink(trashed.path).catch(() => {});
      // The row never recorded the replacement (a crash leaves no post-run
      // identity), so it still describes this original, and the restored file
      // carries the inode its `inode_key` names. What a scan may have done in
      // the empty window is the one thing to undo: mark it missing.
      if (row.missing_since_ms !== null) files.clearMissing(row.id);
      await unlink(notePath).catch(() => {});
      summary.restored += 1;
      say(`Restored "${target}" from trash after an interrupted replacement.`);
    } catch (error) {
      refuse(`recovery failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return summary;
};
