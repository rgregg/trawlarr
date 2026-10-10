import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { walkFiles } from './walk.js';

/** Counts the synchronous canonicalisations the walk makes. */
const realpathCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: ((...args: Parameters<typeof actual.realpathSync>) => {
      realpathCalls.count += 1;
      return actual.realpathSync(...args);
    }) as typeof actual.realpathSync,
  };
});

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-walk-blocking-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A library of `folders` film folders plus the reserved directory, walked once. */
const realpathCallsToWalk = async (folders: number): Promise<number> => {
  const root = join(base, `library-${String(folders)}`);
  mkdirSync(join(root, '.trawlarr', 'trash'), { recursive: true });
  writeFileSync(join(root, '.trawlarr', 'trash', 'deleted.mkv'), 'x');
  for (let index = 0; index < folders; index += 1) {
    const folder = join(root, `Film ${String(index)}`);
    mkdirSync(folder);
    writeFileSync(join(folder, 'film.mkv'), 'x');
  }

  const before = realpathCalls.count;
  const found: string[] = [];
  for await (const entry of walkFiles({
    roots: [root],
    extensions: ['mkv'],
    exclude: [join(root, '.trawlarr')],
  })) {
    found.push(entry.path);
  }
  expect(found).toHaveLength(folders);
  return realpathCalls.count - before;
};

// The exclude check canonicalised every directory it met, synchronously, on
// the daemon's only thread. On a network library each of those is a stat that
// can queue behind a replacement's writes for seconds, so a scan overlapping a
// copy held the event loop once per folder. What the walk reads synchronously
// must not grow with the size of the library.
it('makes no synchronous filesystem read per directory', async () => {
  const small = await realpathCallsToWalk(2);
  const large = await realpathCallsToWalk(40);

  expect(large).toBe(small);
});
