import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import {
  DEFAULT_COMPANION_EXTENSIONS,
  DEFAULT_EXTENSIONS,
  OverlappingRootsError,
  RelativeReservedDirectoryError,
  ReservedDirectoryOverlapsRootError,
  createLibraryRepo,
  type LibraryRepo,
} from './library-repo.js';

const NOW = 1_700_000_000_000;
let db: Db;
let repo: LibraryRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createLibraryRepo(db);
});

describe('create', () => {
  it('round-trips every field, including the JSON columns', () => {
    const created = repo.create({
      name: 'Movies',
      roots: ['/media/movies', '/media/movies-4k'],
      extensions: ['mkv', 'mp4'],
      companionExtensions: ['srt', 'nfo'],
      stagingDir: '/media/movies/.trawlarr',
      trashDir: '/media/movies/.trawlarr-trash',
      allowHardlinked: true,
      nowMs: NOW,
    });
    expect(created).toMatchObject({
      name: 'Movies',
      roots: ['/media/movies', '/media/movies-4k'],
      extensions: ['mkv', 'mp4'],
      companionExtensions: ['srt', 'nfo'],
      allowHardlinked: true,
      enabled: true,
      pausedReason: null,
      flowId: null,
    });
    expect(repo.getById(created.id)).toEqual(created);
  });

  it('applies sensible defaults', () => {
    const created = repo.create({ name: 'TV', roots: ['/media/tv'], nowMs: NOW });
    expect(created.extensions).toEqual([...DEFAULT_EXTENSIONS]);
    expect(created.companionExtensions).toEqual([...DEFAULT_COMPANION_EXTENSIONS]);
    expect(created.allowHardlinked).toBe(false);
    expect(created.stagingDir).toBeNull();
  });

  it('rejects a duplicate name', () => {
    repo.create({ name: 'Movies', roots: ['/a'], nowMs: NOW });
    expect(() => repo.create({ name: 'Movies', roots: ['/b'], nowMs: NOW })).toThrow();
  });

  it('rejects an empty roots list', () => {
    expect(() => repo.create({ name: 'Empty', roots: [], nowMs: NOW })).toThrow(
      /at least one root/i,
    );
  });

  it('rejects roots that overlap each other', () => {
    // One file under two roots of the same library would be scanned twice.
    expect(() =>
      repo.create({ name: 'Nested', roots: ['/media/movies', '/media/movies/4k'], nowMs: NOW }),
    ).toThrow(OverlappingRootsError);
  });

  it('rejects a root that overlaps an existing library', () => {
    // A file in two libraries would be driven toward two different states by
    // two flows, fighting forever.
    repo.create({ name: 'Movies', roots: ['/media/movies'], nowMs: NOW });
    expect(() =>
      repo.create({ name: 'Movies4k', roots: ['/media/movies/4k'], nowMs: NOW }),
    ).toThrow(OverlappingRootsError);
  });

  it('allows sibling roots that merely share a prefix string', () => {
    // '/media/movies-4k' is not inside '/media/movies' despite the prefix.
    repo.create({ name: 'Movies', roots: ['/media/movies'], nowMs: NOW });
    expect(() =>
      repo.create({ name: 'Movies4k', roots: ['/media/movies-4k'], nowMs: NOW }),
    ).not.toThrow();
  });

  it('normalises roots before comparing them', () => {
    repo.create({ name: 'Movies', roots: ['/media/movies/'], nowMs: NOW });
    expect(() => repo.create({ name: 'Dup', roots: ['/media/movies/./'], nowMs: NOW })).toThrow(
      OverlappingRootsError,
    );
  });

  it('rejects a stagingDir that equals a library root', () => {
    // pathContains(root, root) is true by design, so an unvalidated equal
    // stagingDir would prune the root itself out of every scan — the
    // library would look permanently, silently empty.
    expect(() =>
      repo.create({
        name: 'Movies',
        roots: ['/media/movies'],
        stagingDir: '/media/movies',
        nowMs: NOW,
      }),
    ).toThrow(ReservedDirectoryOverlapsRootError);
  });

  it('rejects a stagingDir that contains a library root', () => {
    expect(() =>
      repo.create({
        name: 'Movies4k',
        roots: ['/media/movies/4k'],
        stagingDir: '/media/movies',
        nowMs: NOW,
      }),
    ).toThrow(ReservedDirectoryOverlapsRootError);
  });

  it('rejects a trashDir that contains a library root', () => {
    expect(() =>
      repo.create({
        name: 'Movies',
        roots: ['/media/movies'],
        trashDir: '/media',
        nowMs: NOW,
      }),
    ).toThrow(ReservedDirectoryOverlapsRootError);
  });

  it('allows a stagingDir inside a root — the legitimate, default shape', () => {
    expect(() =>
      repo.create({
        name: 'Movies',
        roots: ['/media/movies'],
        stagingDir: '/media/movies/.trawlarr/staging',
        nowMs: NOW,
      }),
    ).not.toThrow();
  });

  it('rejects a relative stagingDir', () => {
    // resolve() is defined against process.cwd() — but a library has
    // multiple roots and the server's cwd has no relationship to any of
    // them, so there is no correct base to resolve a relative stagingDir
    // against. Silently resolving against cwd was the bug: a relative
    // stagingDir would stage transcodes into wherever the service
    // happened to be started from.
    expect(() =>
      repo.create({
        name: 'Movies',
        roots: ['/media/movies'],
        stagingDir: 'staging',
        nowMs: NOW,
      }),
    ).toThrow(RelativeReservedDirectoryError);
  });

  it('rejects a relative trashDir', () => {
    expect(() =>
      repo.create({
        name: 'Movies',
        roots: ['/media/movies'],
        trashDir: 'trash',
        nowMs: NOW,
      }),
    ).toThrow(RelativeReservedDirectoryError);
  });

  it('accepts an absolute stagingDir', () => {
    // Guards against the relative-path check being over-broad.
    const created = repo.create({
      name: 'Movies',
      roots: ['/media/movies'],
      stagingDir: '/config/staging',
      nowMs: NOW,
    });
    expect(created.stagingDir).toBe(resolve('/config/staging'));
  });
});

describe('lookup and mutation', () => {
  it('finds a library by name and lists all of them', () => {
    const a = repo.create({ name: 'Movies', roots: ['/a'], nowMs: NOW });
    const b = repo.create({ name: 'TV', roots: ['/b'], nowMs: NOW });
    expect(repo.getByName('Movies')?.id).toBe(a.id);
    expect(
      repo
        .list()
        .map((l) => l.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('returns null for a library that does not exist', () => {
    expect(repo.getById('nope')).toBeNull();
    expect(repo.getByName('nope')).toBeNull();
  });

  it('attaches a flow', () => {
    const lib = repo.create({ name: 'Movies', roots: ['/a'], nowMs: NOW });
    db.prepare(
      `INSERT INTO flow (id, name, definition_json, definition_hash, created_at, updated_at)
       VALUES ('f1', 'HEVC', '{}', 'h', ?, ?)`,
    ).run(NOW, NOW);
    repo.setFlow(lib.id, 'f1');
    expect(repo.getById(lib.id)?.flowId).toBe('f1');
  });

  it('pauses with a stated reason and resumes', () => {
    const lib = repo.create({ name: 'Movies', roots: ['/a'], nowMs: NOW });
    repo.pause(lib.id, 'flow references a missing plugin');
    expect(repo.getById(lib.id)).toMatchObject({
      enabled: false,
      pausedReason: 'flow references a missing plugin',
    });
    repo.resume(lib.id);
    expect(repo.getById(lib.id)).toMatchObject({ enabled: true, pausedReason: null });
  });
});
