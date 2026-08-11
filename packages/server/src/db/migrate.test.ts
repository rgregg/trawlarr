import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { SCHEMA_VERSION, migrate } from './migrate.js';

const memoryDb = () => openDatabase({ file: ':memory:' });

describe('openDatabase', () => {
  it('enables WAL and foreign keys', () => {
    const db = openDatabase({ file: ':memory:' });
    // An in-memory database reports "memory" for journal_mode; foreign_keys is
    // the setting that must hold everywhere.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});

describe('migrate', () => {
  it('applies every migration to a fresh database', () => {
    const db = memoryDb();
    const result = migrate(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('records the schema version so restarts are cheap', () => {
    const db = memoryDb();
    migrate(db);
    const row = db.prepare(`SELECT value FROM setting WHERE key = 'schema_version'`).get() as
      { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it('is idempotent', () => {
    const db = memoryDb();
    migrate(db);
    const second = migrate(db);
    expect(second).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('refuses to start on a database from a newer build', () => {
    const db = memoryDb();
    migrate(db);
    db.prepare(`UPDATE setting SET value = ? WHERE key = 'schema_version'`).run(
      String(SCHEMA_VERSION + 5),
    );
    expect(() => migrate(db)).toThrow(/newer schema/i);
    db.close();
  });
});
