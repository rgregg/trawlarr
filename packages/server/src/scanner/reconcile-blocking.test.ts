import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { FAKE_PROBE_DOCUMENT } from '../../test/helpers/fake-ffprobe.js';
import { scanLibrary } from './scan-library.js';

/** Counts the synchronous canonicalisations made by trawlarr's own modules. */
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

const fixedProbe = (path: string): ProbeData =>
  ({
    ...FAKE_PROBE_DOCUMENT,
    format: { ...FAKE_PROBE_DOCUMENT.format, filename: path },
  }) as ProbeData;

let base: string;
let db: Db;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-reconcile-blocking-'));
  db = openDatabase({ file: ':memory:' });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

/** A season of `episodes` files is scanned, deleted, and reported by its folder. */
const realpathCallsToMarkMissing = async (episodes: number): Promise<number> => {
  const root = join(base, `library-${String(episodes)}`);
  const season = join(root, 'Show', 'Season 1');
  mkdirSync(season, { recursive: true });
  writeFileSync(join(root, 'film.mkv'), 'a file that stays, so the root is not empty');
  for (let index = 0; index < episodes; index += 1) {
    writeFileSync(join(season, `e${String(index)}.mkv`), `episode ${String(index)}`);
  }
  const libraryId = createLibraryRepo(db).create({
    name: `Shows ${String(episodes)}`,
    roots: [root],
    extensions: ['mkv'],
    nowMs: 0,
  }).id;
  const scan = (scope?: string[]): ReturnType<typeof scanLibrary> =>
    scanLibrary({
      db,
      libraryId,
      ffprobePath: 'unused',
      nowMs: () => 0,
      scope,
      probeFileImpl: async (input) => fixedProbe(input.path),
    });
  await scan();
  rmSync(season, { recursive: true });

  const before = realpathCalls.count;
  const summary = await scan([join(root, 'Show')]);
  expect(summary.missing).toBe(episodes);
  return realpathCalls.count - before;
};

// The missing pass asked `pathContains(root, row.path)` of every row the scan
// had not seen, in one synchronous `filter`: two `realpathSync` per row, on the
// daemon's only thread. A deleted season is exactly a scoped scan with many
// unseen rows, and on a network library each of those reads can wait seconds
// behind a copy. What the pass reads synchronously must not grow with the
// number of rows it has to consider — and is, in fact, nothing.
it('makes no synchronous filesystem read per unseen row', async () => {
  const small = await realpathCallsToMarkMissing(2);
  const large = await realpathCallsToMarkMissing(40);

  expect(large).toBe(small);
  expect(large).toBe(0);
});
