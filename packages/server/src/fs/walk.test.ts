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
});
