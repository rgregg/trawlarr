import { opendir, stat } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { extname, join } from 'node:path';
import { isWorkingFileName } from '@trawlarr/core';
import { createSubtreeMatcher } from './path-contains.js';

/**
 * Yield every file under `roots` whose extension matches, with its stat.
 *
 * Directory symlinks are not followed: a link pointing at an ancestor would
 * make the walk run forever, and media libraries do contain such links.
 * An unreadable directory or root is skipped rather than fatal — one bad
 * mount must not stop a library scan.
 *
 * `exclude` prunes whole subtrees — staging and trash directories, most
 * notably — rather than filtering matched files one by one: a directory
 * whose resolved path is contained in `exclude` (per
 * {@link createSubtreeMatcher}, the segment-aware, alias-aware comparison of
 * `pathContains` without its per-path filesystem reads)
 * is never opened, so nothing beneath it is ever visited or yielded. This
 * matters beyond performance: a half-written staged transcode must never
 * be probed mid-write, and a trashed file must never be re-admitted as
 * library media.
 *
 * Files named as trawlarr's own scratch ({@link isWorkingFileName}) are
 * skipped wherever they appear: those live in the media's own directory, so
 * no excluded subtree can cover them.
 *
 * NOTHING A SINGLE DIRECTORY DOES CAN ABORT THE WALK. A directory that
 * cannot be opened is skipped, and so is one that fails part way THROUGH
 * being read — a distinct case, because `opendir` has already succeeded by
 * then and the error arrives from the iterator on a later batch. That
 * happens for real: the directory is removed, a permission changes, or an
 * NFS export answers `ESTALE` because a file was replaced underneath the
 * reader. Left unguarded it escaped this generator and abandoned the whole
 * library pass, leaving thousands of untouched files unscanned because one
 * entry moved.
 */
export async function* walkFiles(input: {
  roots: readonly string[];
  extensions: readonly string[];
  exclude?: readonly string[];
  /**
   * Told about each scratch file the walk skips, so a caller that wants to
   * clean up after dead workers does not have to walk the library a second time
   * (on a network mount that is the whole cost).
   */
  onWorkingFile?: (path: string) => void;
  /** Seam: a test drives a directory that fails mid-iteration. */
  openDir?: (path: string) => Promise<AsyncIterable<Dirent>>;
}): AsyncGenerator<{ path: string; stat: Stats }> {
  const wanted = new Set(input.extensions.map((extension) => extension.toLowerCase()));
  if (wanted.size === 0) return;

  const openDir = input.openDir ?? opendir;
  // Built once, not `pathContains` per directory: that canonicalises the
  // directory it is asked about, a synchronous stat of every segment, on the
  // daemon's only thread. On a network library each one can queue behind a
  // replacement's writes, so a scan overlapping a copy froze the API once per
  // folder. Sound here because the walk never follows a directory symlink —
  // see `createSubtreeMatcher`.
  const isExcluded = createSubtreeMatcher({
    roots: input.roots,
    subtrees: input.exclude ?? [],
  });

  const pending = [...input.roots];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    if (isExcluded(dir)) continue;
    let entries;
    try {
      entries = await openDir(dir);
    } catch {
      continue;
    }

    // Stepped by hand rather than `for await`, so that the guard covers
    // ADVANCING the directory and nothing else. A `try` wrapped around a
    // `for await` body would also swallow whatever the consumer throws back
    // into this generator, turning a caller's bug into a silently truncated
    // walk.
    const iterator = entries[Symbol.asyncIterator]();
    for (;;) {
      let step: IteratorResult<Dirent>;
      try {
        step = await iterator.next();
      } catch {
        break; // Unreadable from here on. Other directories are unaffected.
      }
      if (step.done === true) break;
      const entry = step.value;

      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isExcluded(path)) continue;
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;

      // Trawlarr's own scratch, written beside the media because it has to be
      // on the media's filesystem — never library media, whatever extension
      // it carries. Refused by NAME rather than by asking whether a run owns
      // it: a cross-device staging copy orphaned by a killed worker has no
      // run left to ask, and was scanned, probed and marked good. Files only:
      // a DIRECTORY that happens to be called `.trawlarr-old` is the user's,
      // and is walked like any other.
      if (isWorkingFileName(entry.name)) {
        input.onWorkingFile?.(path);
        continue;
      }

      const extension = extname(entry.name).slice(1).toLowerCase();
      if (!wanted.has(extension)) continue;

      let stats: Stats;
      try {
        stats = await stat(path);
      } catch {
        continue; // Vanished between being listed and being stat'd.
      }
      yield { path, stat: stats };
    }
  }
}
