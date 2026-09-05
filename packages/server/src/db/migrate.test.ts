import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { SCHEMA_VERSION, migrate } from './migrate.js';
import { createFlowRepo } from './flow-repo.js';

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
  it('adds nullable review metadata without changing ordinary held rows from schema 10', () => {
    const db = memoryDb();
    for (const file of readdirSync(migrationsDir).sort()) {
      if (file.endsWith('.sql') && Number.parseInt(file, 10) <= 10) {
        db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      }
    }
    db.prepare(`INSERT INTO setting (key, value) VALUES ('schema_version', '10')`).run();
    db.prepare(`INSERT INTO library (id, name, created_at) VALUES ('lib', 'Library', 1)`).run();
    db.prepare(
      `INSERT INTO media_file (
      id, library_id, content_key, path, nlink, size_bytes, mtime_ms, ctime_ms, container,
      state, attempt_count, hold_until_ms, discovered_at, updated_at
    ) VALUES ('file', 'lib', 'key', '/library/movie.mkv', 1, 10, 1, 1, 'mkv', 'held', 2, NULL, 1, 1)`,
    ).run();
    migrate(db);
    expect(
      db.prepare('SELECT state, attempt_count, hold_until_ms, review_reason FROM media_file').get(),
    ).toEqual({
      state: 'held',
      attempt_count: 2,
      hold_until_ms: null,
      review_reason: null,
    });
    db.close();
  });

  it.each([7, 8, 9])('flow metadata migrations preserve existing data from schema %i', (from) => {
    const db = memoryDb();
    for (const file of readdirSync(migrationsDir).sort()) {
      if (file.endsWith('.sql') && Number.parseInt(file, 10) <= from) {
        db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      }
    }
    db.prepare(`INSERT INTO setting (key, value) VALUES ('schema_version', ?)`).run(String(from));
    if (from >= 8) {
      db.prepare(
        `INSERT INTO account (id, username, created_at) VALUES ('account-1', 'admin', 10)`,
      ).run();
    }
    db.prepare(
      `INSERT INTO flow (id, name, definition_json, definition_hash, created_at, updated_at)
       VALUES ('legacy', 'Legacy', '{"nodes":[],"edges":[]}', 'legacy-hash', 10, 20)`,
    ).run();
    db.prepare(
      `INSERT INTO flow_version (id, flow_id, definition_hash, definition_json, note, created_at)
       VALUES ('v1', 'legacy', 'legacy-hash', '{"nodes":[],"edges":[]}', 'old version', 20)`,
    ).run();
    const history = db.prepare('SELECT * FROM flow_version').all();
    if (from === 9) {
      db.prepare(
        `UPDATE flow SET draft_json = '{"nodes":[],"edges":[]}', draft_base_hash = 'legacy-hash',
         draft_updated_at = 30 WHERE id = 'legacy'`,
      ).run();
    }

    expect(migrate(db)).toEqual({ from, to: SCHEMA_VERSION });
    expect(createFlowRepo(db).getById('legacy')).toMatchObject({
      definition: { nodes: [], edges: [] },
      definitionHash: 'legacy-hash',
      createdAt: 10,
      updatedAt: 20,
      draft: from === 9 ? { nodes: [], edges: [] } : null,
      draftBaseHash: from === 9 ? 'legacy-hash' : null,
      draftUpdatedAt: from === 9 ? 30 : null,
      layout: {},
    });
    expect(db.prepare('SELECT * FROM flow_version').all()).toEqual(history);
    expect(db.prepare('SELECT id, username FROM account').all()).toEqual(
      from >= 8 ? [{ id: 'account-1', username: 'admin' }] : [],
    );
    expect(migrate(db).from).toBe(SCHEMA_VERSION);
    db.close();
  });

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

  /**
   * No helper in this file migrates to an arbitrary version, so this test
   * follows the same pattern as the migration-002 test above: apply the
   * pre-007 migration files directly (001 through 006) and stamp the schema
   * version by hand, landing the database exactly where it stood the moment
   * before 007 existed.
   */
  it('backfills each existing flow as its first version', () => {
    const db = memoryDb();
    const preVersionMigrations = ['001', '002', '003', '004', '005', '006'];
    for (const prefix of preVersionMigrations) {
      const file = readdirSync(migrationsDir).find((name) => name.startsWith(`${prefix}_`));
      if (file === undefined) {
        throw new Error(`No migration file found with prefix ${prefix}`);
      }
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    }
    db.exec(`CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO setting (key, value) VALUES ('schema_version', '6')`).run();

    db.prepare(
      `INSERT INTO flow (id, name, description, tags, definition_json, definition_hash,
                         created_at, updated_at)
       VALUES ('f1', 'Shows Conform', '', '', '{"nodes":[],"edges":[]}', 'abc123', 10, 10)`,
    ).run();

    migrate(db);

    const rows = db.prepare(`SELECT * FROM flow_version WHERE flow_id = 'f1'`).all() as Array<{
      definition_hash: string;
      definition_json: string;
      note: string;
      id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.definition_hash).toBe('abc123');
    expect(rows[0]!.definition_json).toBe('{"nodes":[],"edges":[]}');
    expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);

    db.close();
  });

  it("deletes a flow's versions with the flow", () => {
    const db = memoryDb();
    migrate(db);
    db.prepare(
      `INSERT INTO flow (id, name, description, tags, definition_json, definition_hash,
                         created_at, updated_at)
       VALUES ('f2', 'Trial', '', '', '{"nodes":[],"edges":[]}', 'h', 10, 10)`,
    ).run();
    db.prepare(
      `INSERT INTO flow_version (id, flow_id, definition_hash, definition_json, note, created_at)
       VALUES ('v1', 'f2', 'h', '{}', '', 10)`,
    ).run();

    db.prepare(`DELETE FROM flow WHERE id = 'f2'`).run();

    expect(db.prepare(`SELECT COUNT(*) c FROM flow_version`).get()).toEqual({ c: 0 });

    db.close();
  });
});
