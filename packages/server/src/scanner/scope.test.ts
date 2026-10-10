import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { ScopeError, validateScope } from './scope.js';

let base: string;
let root: string;
let db: Db;
let library: LibraryRecord;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-scope-'));
  root = join(base, 'library');
  mkdirSync(join(root, '.trawlarr', 'trash'), { recursive: true });
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  library = createLibraryRepo(db).create({ name: 'Movies', roots: [root], nowMs: 0 });
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('validateScope', () => {
  it('accepts a file and a folder inside a root, and the root itself', () => {
    const paths = [join(root, 'Film', 'film.mkv'), join(root, 'Show'), root];
    for (const path of paths) {
      expect(validateScope({ library, paths: [path] })).toEqual([path]);
    }
    expect(validateScope({ library, paths: paths.slice(0, 2) })).toEqual(paths.slice(0, 2));
  });

  // A watcher burst for a new folder names the folder, its subfolders and the
  // files in them. Each folder named is walked to the bottom, so keeping the
  // ones beneath it walks the same subtree once per level.
  it('drops a path that lies under another path of the same scope, whichever came first', () => {
    const show = join(root, 'Show');
    const film = join(root, 'Film', 'film.mkv');
    expect(
      validateScope({
        library,
        paths: [join(show, 'Season 1', 'e1.mkv'), show, film, join(show, 'Season 1')],
      }),
    ).toEqual([show, film]);
  });

  it('keeps only the root when the root is named with paths inside it', () => {
    expect(
      validateScope({ library, paths: [join(root, 'Film'), root, join(root, 'Show', 'e1.mkv')] }),
    ).toEqual([root]);
  });

  it('does not take a sibling that shares a name prefix for a path underneath', () => {
    const paths = [join(root, 'Show'), join(root, 'Show 2'), join(root, 'Show.mkv')];
    expect(validateScope({ library, paths })).toEqual(paths);
  });

  // The refusals are about each path as named, so a covered path is still
  // checked before it is dropped.
  it('still refuses a reserved path that another scope path covers', () => {
    expect(() =>
      validateScope({ library, paths: [root, join(root, '.trawlarr', 'trash', 'deleted.mkv')] }),
    ).toThrow(ScopeError);
  });

  it('accepts a path that does not exist: a deletion is reported by what is gone', () => {
    const gone = join(root, 'Deleted Film', 'gone.mkv');
    expect(validateScope({ library, paths: [gone] })).toEqual([gone]);
  });

  it('normalises a trailing slash and collapses duplicates', () => {
    expect(
      validateScope({ library, paths: [`${join(root, 'Film')}/`, join(root, 'Film')] }),
    ).toEqual([join(root, 'Film')]);
  });

  it('refuses a relative path', () => {
    expect(() => validateScope({ library, paths: ['Film/film.mkv'] })).toThrow(ScopeError);
  });

  it('refuses a path with ".." segments, wherever it would land', () => {
    expect(() => validateScope({ library, paths: [`${root}/Film/../Film/film.mkv`] })).toThrow(
      ScopeError,
    );
  });

  it('refuses a path outside every root, naming it', () => {
    const outside = join(base, 'elsewhere', 'x.mkv');
    expect(() => validateScope({ library, paths: [join(root, 'ok.mkv'), outside] })).toThrow(
      expect.objectContaining({ path: outside }),
    );
  });

  it('refuses a sibling of the root that shares its name as a prefix', () => {
    expect(() => validateScope({ library, paths: [`${root}-old/x.mkv`] })).toThrow(ScopeError);
  });

  it('refuses a path inside a reserved directory', () => {
    expect(() =>
      validateScope({ library, paths: [join(root, '.trawlarr', 'trash', 'deleted.mkv')] }),
    ).toThrow(ScopeError);
  });

  describe('lexically', () => {
    it('accepts a path inside a root', () => {
      const paths = [join(root, 'Film', 'film.mkv')];
      expect(validateScope({ library, paths, lexical: true })).toEqual(paths);
    });

    it('refuses a path outside every root', () => {
      expect(() =>
        validateScope({ library, paths: [join(base, 'elsewhere', 'x.mkv')], lexical: true }),
      ).toThrow(ScopeError);
    });

    it('refuses a path in a reserved directory', () => {
      expect(() =>
        validateScope({ library, paths: [join(root, '.trawlarr', 'trash')], lexical: true }),
      ).toThrow(ScopeError);
    });
  });
});
