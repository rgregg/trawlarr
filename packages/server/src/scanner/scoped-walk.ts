import { lstat, realpath } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import { isWorkingFileName } from '@trawlarr/core';
import { createSubtreeMatcher } from '../fs/path-contains.js';
import { walkFiles } from '../fs/walk.js';

/**
 * True when `target` lies under one of `roots` and its real path is the
 * spelled path mapped onto that root's real location — so no symlink sits
 * anywhere between the root and the target. An unresolvable target is false.
 */
async function isWithinLibrary(
  target: string,
  roots: readonly { spelled: string; canonical: string }[],
): Promise<boolean> {
  const absolute = resolve(target);
  const under = roots.filter(
    ({ spelled }) => absolute === spelled || absolute.startsWith(spelled + sep),
  );
  if (under.length === 0) return false;
  let actual: string;
  try {
    actual = await realpath(absolute);
  } catch {
    return false;
  }
  return under.some(
    ({ spelled, canonical }) => actual === canonical + absolute.slice(spelled.length),
  );
}

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
  // Built once for the whole scope, as `walkFiles` builds its own: a named
  // file is judged against the same reserved directories a full walk prunes.
  const isExcluded = createSubtreeMatcher({
    roots: input.libraryRoots,
    subtrees: input.exclude,
  });

  // Each root as it is spelled and as it really is. A root that cannot be
  // resolved contributes nothing: nothing under it can be shown to be library.
  const roots: { spelled: string; canonical: string }[] = [];
  for (const root of input.libraryRoots) {
    const spelled = resolve(root);
    try {
      roots.push({ spelled, canonical: await realpath(spelled) });
    } catch {
      // Unreadable root: skipped, as `walkFiles` skips an unreadable root.
    }
  }

  for (const target of input.scope) {
    let stats: Stats;
    try {
      stats = await lstat(target);
    } catch {
      continue; // Gone, or unreadable: nothing here to observe.
    }

    // The full walk never descends a directory symlink, so a path that only
    // exists THROUGH one must not become library media by being named. `lstat`
    // refuses a symlink in the last component only, so the middle of the path
    // is checked here: it must resolve to where its library root says it
    // should. Checked by the walk, not left to the caller, because a scope
    // path arrives from a notification and has not been vetted by anyone.
    if (!(await isWithinLibrary(target, roots))) continue;

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
    // A file must not become library media by being reported when it would
    // not have by being found: a trashed or half-staged file named by a
    // notification would otherwise be re-admitted, though the full walk never
    // reaches it.
    if (isExcluded(target)) continue;
    if (isWorkingFileName(basename(target))) continue;
    if (!wanted.has(extname(target).slice(1).toLowerCase())) continue;
    if (yielded.has(target)) continue;
    yielded.add(target);
    yield { path: target, stat: stats };
  }
}
