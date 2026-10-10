import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createMediaFileRepo, type MediaFileRepo } from '../db/media-file-repo.js';
import { FAKE_PROBE_DOCUMENT } from '../../test/helpers/fake-ffprobe.js';
import { reconcileMissing } from './reconcile.js';
import { scanLibrary } from './scan-library.js';

const fixedProbe = (path: string): ProbeData =>
  ({
    ...FAKE_PROBE_DOCUMENT,
    format: { ...FAKE_PROBE_DOCUMENT.format, filename: path },
  }) as ProbeData;

let base: string;
let root: string;
let db: Db;
let library: LibraryRecord;
let repo: MediaFileRepo;

const missingPaths = (): string[] =>
  repo
    .listByLibrary({ libraryId: library.id })
    .filter((row) => row.missing_since_ms !== null)
    .map((row) => row.path)
    .sort();

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-reconcile-scoped-'));
  root = join(base, 'library');
  mkdirSync(join(root, 'Show'), { recursive: true });
  mkdirSync(join(root, 'Show 2'), { recursive: true });
  writeFileSync(join(root, 'Show', 'e1.mkv'), 'show e1');
  writeFileSync(join(root, 'Show', 'e2.mkv'), 'show e2');
  writeFileSync(join(root, 'Show 2', 'e1.mkv'), 'show two e1');
  writeFileSync(join(root, 'film.mkv'), 'film');
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  library = createLibraryRepo(db).create({
    name: 'Shows',
    roots: [root],
    extensions: ['mkv'],
    nowMs: 0,
  });
  repo = createMediaFileRepo(db);
  await scanLibrary({
    db,
    libraryId: library.id,
    ffprobePath: 'unused',
    nowMs: () => 0,
    probeFileImpl: async (input) => fixedProbe(input.path),
  });
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('listUnderPaths', () => {
  it('returns the row at a path and the rows under a folder', () => {
    const rows = repo.listUnderPaths({
      libraryId: library.id,
      paths: [join(root, 'Show'), join(root, 'film.mkv')],
    });
    expect(rows.map((row) => row.path).sort()).toEqual([
      join(root, 'Show', 'e1.mkv'),
      join(root, 'Show', 'e2.mkv'),
      join(root, 'film.mkv'),
    ]);
  });

  // Review Focus 3.
  it('does not return a sibling folder whose name starts with the scope folder name', () => {
    const rows = repo.listUnderPaths({ libraryId: library.id, paths: [join(root, 'Show')] });
    expect(rows.some((row) => row.path.startsWith(join(root, 'Show 2')))).toBe(false);
  });

  it('returns a row once when two scope paths cover it', () => {
    const rows = repo.listUnderPaths({
      libraryId: library.id,
      paths: [join(root, 'Show'), join(root, 'Show', 'e1.mkv')],
    });
    expect(rows.filter((row) => row.path === join(root, 'Show', 'e1.mkv'))).toHaveLength(1);
  });
});

describe('reconcileMissing with a scope', () => {
  it('marks a deleted file missing when its path is in scope', async () => {
    unlinkSync(join(root, 'Show', 'e1.mkv'));

    const summary = await reconcileMissing({
      library,
      mediaFileRepo: repo,
      seenFileIds: new Set(),
      nowMs: 5,
      scope: [join(root, 'Show', 'e1.mkv')],
    });

    expect(summary.missing).toBe(1);
    expect(missingPaths()).toEqual([join(root, 'Show', 'e1.mkv')]);
  });

  // The whole point of the restriction: a scoped scan saw almost nothing, and
  // "not seen" must not mean "gone" for the rest of the library.
  it('never marks a row outside the scope, even though this scan did not see it', async () => {
    unlinkSync(join(root, 'film.mkv'));

    const summary = await reconcileMissing({
      library,
      mediaFileRepo: repo,
      seenFileIds: new Set(),
      nowMs: 5,
      scope: [join(root, 'Show')],
    });

    expect(summary.missing).toBe(0);
    expect(missingPaths()).toEqual([]);
  });

  it('marks every row under a deleted folder that is in scope', async () => {
    rmSync(join(root, 'Show'), { recursive: true });

    await reconcileMissing({
      library,
      mediaFileRepo: repo,
      seenFileIds: new Set(),
      nowMs: 5,
      scope: [join(root, 'Show')],
    });

    expect(missingPaths()).toEqual([join(root, 'Show', 'e1.mkv'), join(root, 'Show', 'e2.mkv')]);
  });

  it('leaves a row that is in scope and still on disk alone', async () => {
    const summary = await reconcileMissing({
      library,
      mediaFileRepo: repo,
      seenFileIds: new Set(),
      nowMs: 5,
      scope: [join(root, 'Show')],
    });
    expect(summary.missing).toBe(0);
  });
});
