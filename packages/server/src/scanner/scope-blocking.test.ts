import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { libraryContaining, ScopeError, validateScope } from './scope.js';

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

let base: string;
let root: string;
let db: Db;
let library: LibraryRecord;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-scope-blocking-'));
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

// A request handler runs on the daemon's only thread. A synchronous realpath
// of a network directory per webhook is the stall removed from the watcher
// and the walk; the scan that follows re-validates canonically.
describe('scope checks made by a request handler', () => {
  it('validates a scope lexically without reading the filesystem', () => {
    const before = realpathCalls.count;
    expect(validateScope({ library, paths: [join(root, 'Film')], lexical: true })).toEqual([
      join(root, 'Film'),
    ]);
    expect(() => validateScope({ library, paths: ['/elsewhere/x.mkv'], lexical: true })).toThrow(
      ScopeError,
    );
    expect(realpathCalls.count).toBe(before);
  });

  it('still canonicalises by default', () => {
    const before = realpathCalls.count;
    validateScope({ library, paths: [join(root, 'Film')] });
    expect(realpathCalls.count).toBeGreaterThan(before);
  });

  it('finds the library containing a path without reading the filesystem', () => {
    const other = createLibraryRepo(db).create({
      name: 'Shows',
      roots: [join(base, 'shows')],
      nowMs: 0,
    });
    const before = realpathCalls.count;

    expect(libraryContaining([other, library], join(root, 'Film', 'a.mkv'))?.id).toBe(library.id);
    expect(libraryContaining([other, library], join(base, 'shows'))?.id).toBe(other.id);
    expect(libraryContaining([library], join(base, 'elsewhere'))).toBeUndefined();
    expect(libraryContaining([library], `${root}-old/x`)).toBeUndefined();

    expect(realpathCalls.count).toBe(before);
  });
});
