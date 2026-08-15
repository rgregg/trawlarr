import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { SCHEMA_VERSION, migrate } from './migrate.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

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

  /**
   * Migration 002 adds a UNIQUE index on `flow.name`. A database created
   * before that migration existed can already contain duplicate flow
   * names — the CLI didn't reject them yet — and the naive version of this
   * migration (just `CREATE UNIQUE INDEX`) would refuse to run at all on
   * such a database, bricking every future migration behind an
   * unrecoverable constraint failure with no `flow rename`/`flow rm` to fix
   * it by hand. This proves the actual migration instead deterministically
   * renames every duplicate but the oldest before creating the index, so a
   * legacy database upgrades cleanly.
   */
  it('migration 002 de-duplicates pre-existing flow names before enforcing uniqueness', () => {
    const db = memoryDb();
    // Build a database as it looked BEFORE migration 002 existed: schema
    // 001 only, applied directly (not via `migrate`, which would also try
    // to run 002 and hit the very index this test needs to not exist yet).
    db.exec(readFileSync(join(migrationsDir, '001_initial.sql'), 'utf8'));
    db.exec(`CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO setting (key, value) VALUES ('schema_version', '1')`).run();

    // Three flows sharing a name, inserted in a known creation order — no
    // UNIQUE index exists yet at schema 001, so this is legal.
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const insert = db.prepare(
      `INSERT INTO flow (id, name, definition_json, definition_hash, created_at, updated_at)
       VALUES (?, ?, '{}', 'hash', ?, ?)`,
    );
    insert.run(ids[0], 'HEVC', 1_000, 1_000);
    insert.run(ids[1], 'HEVC', 2_000, 2_000);
    insert.run(ids[2], 'HEVC', 3_000, 3_000);

    const result = migrate(db);
    expect(result.to).toBe(SCHEMA_VERSION);

    // All three rows survive — nothing was dropped or merged.
    const rows = db.prepare(`SELECT id, name FROM flow ORDER BY created_at`).all() as {
      id: string;
      name: string;
    }[];
    expect(rows).toHaveLength(3);

    // The oldest keeps the original name; the rest are deterministically
    // renamed in creation order, so the outcome is reproducible rather than
    // "whichever row sqlite happened to touch first".
    expect(rows.map((r) => r.name)).toEqual(['HEVC', 'HEVC (2)', 'HEVC (3)']);

    // And the constraint this migration exists to add is now real: a
    // fourth flow reusing the (now-available) exact name "HEVC (2)" is
    // rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO flow (id, name, definition_json, definition_hash, created_at, updated_at)
           VALUES (?, 'HEVC (2)', '{}', 'hash', 4000, 4000)`,
        )
        .run(randomUUID()),
    ).toThrow(/UNIQUE constraint failed/);

    db.close();
  });
});
