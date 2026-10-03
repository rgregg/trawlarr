import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkFiles } from './walk.js';

const tree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-walk-'));
  mkdirSync(join(root, 'nested', 'deep'), { recursive: true });
  writeFileSync(join(root, 'a.mkv'), 'x');
  writeFileSync(join(root, 'b.MP4'), 'x');
  writeFileSync(join(root, 'notes.txt'), 'x');
  writeFileSync(join(root, 'nested', 'c.mkv'), 'x');
  writeFileSync(join(root, 'nested', 'deep', 'd.mkv'), 'x');
  return root;
};

const collect = async (root: string, extensions: string[]): Promise<string[]> => {
  const found: string[] = [];
  for await (const entry of walkFiles({ roots: [root], extensions })) found.push(entry.path);
  return found.map((p) => p.slice(root.length + 1)).sort();
};

describe('walkFiles', () => {
  it('finds matching files recursively', async () => {
    const root = tree();
    expect(await collect(root, ['mkv'])).toEqual(['a.mkv', 'nested/c.mkv', 'nested/deep/d.mkv']);
  });

  it('matches extensions case-insensitively', async () => {
    const root = tree();
    expect(await collect(root, ['mp4'])).toEqual(['b.MP4']);
  });

  it('ignores non-matching extensions', async () => {
    const root = tree();
    expect(await collect(root, ['mkv'])).not.toContain('notes.txt');
  });

  it("never yields trawlarr's own scratch files, even though they carry a media extension", async () => {
    // A cross-device replacement stages its copy in the media's own directory
    // as `.trawlarr-replace-<uuid>.mkv`. Yielded, it became a library row: a
    // scan mid-copy made the owning run fail on a duplicate identity and
    // re-encode the file, and a copy orphaned by a killed worker was tracked
    // as a finished movie while the real one sat in trash.
    const root = tree();
    writeFileSync(
      join(root, 'nested', '.trawlarr-replace-520ab0c8-a5bb-4c6e-8bed-7d19026f12fc.mkv'),
      'x',
    );
    writeFileSync(join(root, 'nested', '.trawlarr-reserve-c.mkv'), 'x');
    expect(await collect(root, ['mkv'])).toEqual(['a.mkv', 'nested/c.mkv', 'nested/deep/d.mkv']);
  });

  it('yields a stat alongside each path, so callers need not stat again', async () => {
    const root = tree();
    for await (const entry of walkFiles({ roots: [root], extensions: ['mkv'] })) {
      expect(entry.stat.isFile()).toBe(true);
      expect(entry.stat.size).toBeGreaterThan(0);
    }
  });

  it('does not follow directory symlinks, which could loop forever', async () => {
    const root = tree();
    symlinkSync(root, join(root, 'nested', 'loop'), 'dir');
    const found = await collect(root, ['mkv']);
    expect(found).toEqual(['a.mkv', 'nested/c.mkv', 'nested/deep/d.mkv']);
  });

  it('skips an unreadable directory rather than aborting the walk', async () => {
    const root = tree();
    const found: string[] = [];
    for await (const entry of walkFiles({
      roots: [root, '/nonexistent-root'],
      extensions: ['mkv'],
    })) {
      found.push(entry.path);
    }
    expect(found).toHaveLength(3);
  });

  it('yields nothing for an empty extension list', async () => {
    expect(await collect(tree(), [])).toEqual([]);
  });

  /**
   * A directory that fails PART WAY THROUGH being read, which is different
   * from one that cannot be opened at all.
   *
   * `opendir` succeeds and the failure surfaces from the async iterator on a
   * later batch: the directory was removed, the mount went stale (`ESTALE`,
   * which is what an NFS export does when a file is replaced underneath a
   * reader), or a permission changed mid-walk. Before this was guarded, that
   * error escaped `walkFiles` entirely and aborted the whole library pass —
   * thousands of untouched files left unscanned because one entry moved.
   */
  const throwingDir = (error: NodeJS.ErrnoException): AsyncIterable<never> => ({
    async *[Symbol.asyncIterator]() {
      throw error;
    },
  });

  it('skips a directory whose iteration fails, and still walks the other roots', async () => {
    const good = tree();
    const bad = tree();
    const stale: NodeJS.ErrnoException = Object.assign(new Error('ESTALE: stale file handle'), {
      code: 'ESTALE',
    });

    const found: string[] = [];
    for await (const entry of walkFiles({
      roots: [bad, good],
      extensions: ['mkv'],
      openDir: async (path) => {
        // `opendir` SUCCEEDS for the bad root; the failure arrives from the
        // iterator, which is the case a try around `opendir` cannot catch.
        if (path === bad) return throwingDir(stale);
        const { opendir } = await import('node:fs/promises');
        return opendir(path);
      },
    })) {
      found.push(entry.path);
    }

    // Everything under the healthy root is still found: one bad directory
    // costs its own subtree, never the whole pass.
    expect(found.filter((p) => p.startsWith(good))).toHaveLength(3);
    expect(found.filter((p) => p.startsWith(bad))).toHaveLength(0);
  });

  it('lets an error thrown BY THE CONSUMER out, rather than swallowing it as a bad directory', async () => {
    // The reason the guard steps the iterator by hand instead of wrapping a
    // `for await` body: a caller's own failure must not be mistaken for an
    // unreadable directory and silently truncate the walk.
    const root = tree();
    const boom = new Error('consumer exploded');
    await expect(
      (async () => {
        for await (const entry of walkFiles({ roots: [root], extensions: ['mkv'] })) {
          expect(entry.path).toContain(root);
          throw boom;
        }
      })(),
    ).rejects.toThrow('consumer exploded');
  });
});
