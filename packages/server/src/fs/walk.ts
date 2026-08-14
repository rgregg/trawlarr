import { opendir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Yield every file under `roots` whose extension matches, with its stat.
 *
 * Directory symlinks are not followed: a link pointing at an ancestor would
 * make the walk run forever, and media libraries do contain such links.
 * An unreadable directory or root is skipped rather than fatal — one bad
 * mount must not stop a library scan.
 */
export async function* walkFiles(input: {
  roots: readonly string[];
  extensions: readonly string[];
}): AsyncGenerator<{ path: string; stat: Stats }> {
  const wanted = new Set(input.extensions.map((extension) => extension.toLowerCase()));
  if (wanted.size === 0) return;

  const pending = [...input.roots];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      continue;
    }

    for await (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
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
