import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

describe('listUnderPaths with unusual paths', () => {
  const seed = async (folders: string[]): Promise<void> => {
    for (const folder of folders) {
      mkdirSync(join(root, folder), { recursive: true });
      writeFileSync(join(root, folder, 'e1.mkv'), `content of ${folder}`);
    }
    await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'unused',
      nowMs: () => 0,
      probeFileImpl: async (input) => fixedProbe(input.path),
    });
  };

  it('returns rows under a folder whose name contains a character outside the BMP', async () => {
    await seed(['Show \u{1F3AC}']);
    const rows = repo.listUnderPaths({
      libraryId: library.id,
      paths: [join(root, 'Show \u{1F3AC}')],
    });
    expect(rows.map((row) => row.path)).toEqual([join(root, 'Show \u{1F3AC}', 'e1.mkv')]);
  });

  it('treats % and _ in a path as themselves', async () => {
    await seed(['100%_Show', '100XYShow']);
    const rows = repo.listUnderPaths({ libraryId: library.id, paths: [join(root, '100%_Show')] });
    expect(rows.map((row) => row.path)).toEqual([join(root, '100%_Show', 'e1.mkv')]);
  });

  it('accepts a scope path with a trailing slash', () => {
    const rows = repo.listUnderPaths({ libraryId: library.id, paths: [`${join(root, 'Show')}/`] });
    expect(rows.map((row) => row.path).sort()).toEqual([
      join(root, 'Show', 'e1.mkv'),
      join(root, 'Show', 'e2.mkv'),
    ]);
  });

  it('returns nothing for an empty list of paths', () => {
    expect(repo.listUnderPaths({ libraryId: library.id, paths: [] })).toEqual([]);
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

// THIS PINS WHAT THE CODE DOES TODAY, NOT WHAT IT OUGHT TO DO. A deleted file
// under a root spelled through a symlink alias (a Docker `/media -> /mnt/media`
// stack) is NOT marked missing, by a full scan or a scoped one: the root is
// canonicalised to where it really is, the row's path cannot be because the
// file is gone, so it stays spelled through the alias and no longer compares
// as being under its root. The row is then never considered at all. Whether
// such a file should be marked is a decision of its own, outside the branch
// that made this check non-blocking; that change had to leave every outcome
// as it found it, and this is the outcome most likely to move by accident.
describe('existing behaviour, pinned: a root spelled through a symlink alias', () => {
  let alias: string;
  let aliased: LibraryRecord;

  const scanAliased = (scope?: string[]): ReturnType<typeof scanLibrary> =>
    scanLibrary({
      db,
      libraryId: aliased.id,
      ffprobePath: 'unused',
      nowMs: () => 0,
      scope,
      probeFileImpl: async (input) => fixedProbe(input.path),
    });
  const aliasedRows = (): { path: string; missing: boolean }[] =>
    repo
      .listByLibrary({ libraryId: aliased.id })
      .map((row) => ({ path: row.path, missing: row.missing_since_ms !== null }))
      .sort((a, b) => a.path.localeCompare(b.path));

  beforeEach(async () => {
    const real = join(base, 'mnt');
    mkdirSync(join(real, 'Film'), { recursive: true });
    writeFileSync(join(real, 'Film', 'a.mkv'), 'film a');
    writeFileSync(join(real, 'Film', 'b.mkv'), 'film b');
    alias = join(base, 'media');
    symlinkSync(real, alias);
    aliased = createLibraryRepo(db).create({
      name: 'Aliased',
      roots: [alias],
      extensions: ['mkv'],
      nowMs: 0,
    });
    await scanAliased();
    unlinkSync(join(alias, 'Film', 'a.mkv'));
  });

  const unmarked = (): { path: string; missing: boolean }[] => [
    { path: join(alias, 'Film', 'a.mkv'), missing: false },
    { path: join(alias, 'Film', 'b.mkv'), missing: false },
  ];

  it('does not mark the deleted file missing on a full scan', async () => {
    const summary = await scanAliased();

    expect(summary.missing).toBe(0);
    expect(summary.rootsUnavailable).toBe(0);
    expect(aliasedRows()).toEqual(unmarked());
  });

  it('does not mark the deleted file missing on a scoped scan of it or of its folder', async () => {
    expect((await scanAliased([join(alias, 'Film', 'a.mkv')])).missing).toBe(0);
    expect((await scanAliased([join(alias, 'Film')])).missing).toBe(0);
    expect(aliasedRows()).toEqual(unmarked());
  });

  it('does not mark it when the missing pass is called directly, with nothing precomputed', async () => {
    const summary = await reconcileMissing({
      library: aliased,
      mediaFileRepo: repo,
      seenFileIds: new Set(),
      nowMs: 5,
    });

    expect(summary).toEqual({ missing: 0, rootsUnavailable: 0, unconfirmed: 0 });
    expect(aliasedRows()).toEqual(unmarked());
  });

  // The other side of the same comparison, so the pin above cannot be met by
  // a check that simply never matches: the same deletion under a root spelled
  // as it really is IS marked.
  it('does mark the same deletion under a root that is not an alias', async () => {
    const plain = join(base, 'plain');
    mkdirSync(join(plain, 'Film'), { recursive: true });
    writeFileSync(join(plain, 'Film', 'a.mkv'), 'plain film a');
    writeFileSync(join(plain, 'Film', 'b.mkv'), 'plain film b');
    const direct = createLibraryRepo(db).create({
      name: 'Direct',
      roots: [plain],
      extensions: ['mkv'],
      nowMs: 0,
    });
    const scanDirect = (): ReturnType<typeof scanLibrary> =>
      scanLibrary({
        db,
        libraryId: direct.id,
        ffprobePath: 'unused',
        nowMs: () => 0,
        probeFileImpl: async (input) => fixedProbe(input.path),
      });
    await scanDirect();
    unlinkSync(join(plain, 'Film', 'a.mkv'));

    expect((await scanDirect()).missing).toBe(1);
  });
});
