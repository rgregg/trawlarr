import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createPluginDocumentRepo, type PluginDocumentRepo } from './plugin-document-repo.js';

const NOW = 1_700_000_000_000;
let db: Db;
let repo: PluginDocumentRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createPluginDocumentRepo(db);
});

describe('plugin document store', () => {
  it('returns undefined for a document that does not exist', () => {
    // processedCheck relies on this: absence must be distinguishable, not an error.
    expect(repo.get('F2FOutputJSONDB', '/media/movie.mkv')).toBeUndefined();
  });

  it('round-trips an inserted document', () => {
    repo.insert('F2FOutputJSONDB', '/media/movie.mkv', { _id: '/media/movie.mkv', DB: 'db1' }, NOW);
    expect(repo.get('F2FOutputJSONDB', '/media/movie.mkv')).toEqual({
      _id: '/media/movie.mkv',
      DB: 'db1',
    });
  });

  it('replaces on insert of the same id, matching the observed remove-then-insert pattern', () => {
    repo.insert('F2FOutputJSONDB', 'k', { v: 1 }, NOW);
    repo.insert('F2FOutputJSONDB', 'k', { v: 2 }, NOW + 1);
    expect(repo.get('F2FOutputJSONDB', 'k')).toEqual({ v: 2 });
  });

  it('merges on update rather than overwriting', () => {
    repo.insert('SettingsGlobalJSONDB', 'globalsettings', { a: 1, b: 2 }, NOW);
    repo.update('SettingsGlobalJSONDB', 'globalsettings', { b: 3 }, NOW + 1);
    expect(repo.get('SettingsGlobalJSONDB', 'globalsettings')).toEqual({ a: 1, b: 3 });
  });

  it('creates the document when updating one that does not exist', () => {
    repo.update('C', 'k', { a: 1 }, NOW);
    expect(repo.get('C', 'k')).toEqual({ a: 1 });
  });

  it('removes a document', () => {
    repo.insert('C', 'k', { a: 1 }, NOW);
    repo.removeOne('C', 'k');
    expect(repo.get('C', 'k')).toBeUndefined();
  });

  it('tolerates removing something absent', () => {
    expect(() => repo.removeOne('C', 'missing')).not.toThrow();
  });

  it('keeps collections isolated', () => {
    repo.insert('A', 'k', { from: 'A' }, NOW);
    repo.insert('B', 'k', { from: 'B' }, NOW);
    expect(repo.get('A', 'k')).toEqual({ from: 'A' });
    expect(repo.get('B', 'k')).toEqual({ from: 'B' });
  });
});
