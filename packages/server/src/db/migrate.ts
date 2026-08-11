import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const loadMigrations = (): Migration[] =>
  readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      if (match?.[1] === undefined) {
        throw new Error(`Migration filename must start with a number: ${name}`);
      }
      return {
        version: Number.parseInt(match[1], 10),
        name,
        sql: readFileSync(join(migrationsDir, name), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);

const MIGRATIONS = loadMigrations();

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

const readVersion = (db: Db): number => {
  db.exec(`CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM setting WHERE key = 'schema_version'`).get() as
    { value: string } | undefined;
  return row === undefined ? 0 : Number.parseInt(row.value, 10);
};

const writeVersion = (db: Db, version: number): void => {
  db.prepare(
    `INSERT INTO setting (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(version));
};

/**
 * Forward-only migrations. A database stamped with a version this build does
 * not know about means someone downgraded; refusing to start is the only safe
 * response, because applying old migrations over a new schema corrupts it.
 */
export const migrate = (db: Db): { from: number; to: number } => {
  const from = readVersion(db);

  if (from > SCHEMA_VERSION) {
    throw new Error(
      `Database has a newer schema (version ${from}) than this build supports ` +
        `(version ${SCHEMA_VERSION}). Upgrade trawlarr or restore an older backup.`,
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (pending.length > 0) {
    db.transaction(() => {
      for (const migration of pending) db.exec(migration.sql);
      writeVersion(db, SCHEMA_VERSION);
    })();
  } else {
    writeVersion(db, SCHEMA_VERSION);
  }

  return { from, to: SCHEMA_VERSION };
};
