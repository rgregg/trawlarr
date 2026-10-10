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
    const paths = [join(root, 'Film', 'film.mkv'), join(root, 'Film'), root];
    expect(validateScope({ library, paths })).toEqual(paths);
  });

  it('accepts a path that does not exist: a deletion is reported by what is gone', () => {
    const gone = join(root, 'Deleted Film', 'gone.mkv');
    expect(validateScope({ library, paths: [gone] })).toEqual([gone]);
  });

  // Review Focus 1.
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
});
