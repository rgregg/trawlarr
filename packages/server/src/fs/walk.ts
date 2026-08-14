import { opendir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname, join } from 'node:path';
import { pathContains } from '../library/paths.js';

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
 * whose resolved path is contained in `exclude` (per {@link pathContains},
 * the same segment-aware comparison used everywhere else in this codebase)
 * is never opened, so nothing beneath it is ever visited or yielded. This
 * matters beyond performance: a half-written staged transcode must never
 * be probed mid-write, and a trashed file must never be re-admitted as
 * library media.
 */
export async function* walkFiles(input: {
  roots: readonly string[];
  extensions: readonly string[];
  exclude?: readonly string[];
}): AsyncGenerator<{ path: string; stat: Stats }> {
  const wanted = new Set(input.extensions.map((extension) => extension.toLowerCase()));
  if (wanted.size === 0) return;

  const excludes = input.exclude ?? [];
  const isExcluded = (path: string): boolean =>
    excludes.some((excluded) => pathContains(excluded, path));

  const pending = [...input.roots];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    if (isExcluded(dir)) continue;
    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      continue;
    }

    for await (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isExcluded(path)) continue;
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = extname(entry.name).replace('.', '').toLowerCase();
      if (!wanted.has(extension)) continue;

      try {
        yield { path, stat: await stat(path) };
      } catch {
        continue;
      }
    }
  }
}
