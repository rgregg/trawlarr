import SqliteDatabase from 'better-sqlite3';

export type Db = SqliteDatabase.Database;

/**
 * Open the single database the server owns. Nothing else ever opens it:
 * worker processes and remote nodes receive job payloads over the wire,
 * which is what keeps one-writer SQLite viable permanently.
 */
export const openDatabase = (input: { file: string }): Db => {
  const db = new SqliteDatabase(input.file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
};
