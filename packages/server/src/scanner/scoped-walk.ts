import { lstat } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { basename, extname } from 'node:path';
import { isWorkingFileName } from '@trawlarr/core';
import { walkFiles } from '../fs/walk.js';

/**
 * Yield the media files a scoped scan is about: each scope path that is a
 * file, and every file under each scope path that is a folder.
 *
 * It applies exactly the rules `walkFiles` applies to a whole library — the
 * extension filter, the refusal of trawlarr's own scratch by name, regular
 * files only, reserved directories pruned — because a file must not become
 * library media by being reported when it would not have by being found.
 *
 * A scope path that does not exist yields nothing and is not an error: a
 * deletion is reported by the path that is now gone, and what that means is
 * the missing pass's question, not the walk's.
 *
 * A file is yielded at most once however many scope paths cover it: a watcher
 * burst for a new folder names the folder and the files in it.
 */
export async function* walkScope(input: {
  scope: readonly string[];
  libraryRoots: readonly string[];
  extensions: readonly string[];
  exclude: readonly string[];
  /** Seam, passed to `walkFiles`: a test counts the directories opened. */
  openDir?: (path: string) => Promise<AsyncIterable<Dirent>>;
}): AsyncGenerator<{ path: string; stat: Stats }> {
  const wanted = new Set(input.extensions.map((extension) => extension.toLowerCase()));
  if (wanted.size === 0) return;
  const yielded = new Set<string>();

  for (const target of input.scope) {
    let stats: Stats;
    try {
      stats = await lstat(target);
    } catch {
      continue; // Gone, or unreadable: nothing here to observe.
    }

    if (stats.isDirectory()) {
      for await (const entry of walkFiles({
        roots: [target],
        pruneRoots: input.libraryRoots,
        extensions: input.extensions,
        exclude: input.exclude,
        openDir: input.openDir,
      })) {
        if (yielded.has(entry.path)) continue;
        yielded.add(entry.path);
        yield entry;
      }
      continue;
    }

    // `lstat`, so a symlink is not a file here — as it is not to `walkFiles`,
    // which asks the directory entry and never follows one.
    if (!stats.isFile()) continue;
    if (isWorkingFileName(basename(target))) continue;
    if (!wanted.has(extname(target).slice(1).toLowerCase())) continue;
    if (yielded.has(target)) continue;
    yielded.add(target);
    yield { path: target, stat: stats };
  }
}
