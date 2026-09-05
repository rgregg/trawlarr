import { randomUUID } from 'node:crypto';
import type { Db } from './connection.js';

/**
 * A signed-in operator. See `008_account.sql` for why `passwordHash` and
 * the OIDC identity are both nullable and mutually independent — an account
 * is one login style or the other, never validated against both.
 */
export interface AccountRecord {
  id: string;
  username: string | null;
  passwordHash: string | null;
  displayName: string | null;
  oidcIssuer: string | null;
  oidcSubject: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface CreatePasswordAccountInput {
  username: string;
  passwordHash: string;
  displayName?: string | null;
  nowMs: number;
}

export interface CreateOidcAccountInput {
  oidcIssuer: string;
  oidcSubject: string;
  displayName?: string | null;
  nowMs: number;
}

export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`An account named "${username}" already exists. Usernames are unique.`);
    this.name = 'DuplicateUsernameError';
  }
}

export interface AccountRepo {
  create(input: CreatePasswordAccountInput): AccountRecord;
  createFromOidc(input: CreateOidcAccountInput): AccountRecord;
  getById(id: string): AccountRecord | null;
  getByUsername(username: string): AccountRecord | null;
  getByOidcIdentity(input: { issuer: string; subject: string }): AccountRecord | null;
  list(): AccountRecord[];
  count(): number;
  remove(id: string): boolean;
  setPassword(id: string, passwordHash: string): void;
  touchLastLogin(id: string, nowMs: number): void;
}

interface AccountRow {
  id: string;
  username: string | null;
  password_hash: string | null;
  display_name: string | null;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  created_at: number;
  last_login_at: number | null;
}

const toRecord = (row: AccountRow): AccountRecord => ({
  id: row.id,
  username: row.username,
  passwordHash: row.password_hash,
  displayName: row.display_name,
  oidcIssuer: row.oidc_issuer,
  oidcSubject: row.oidc_subject,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
});

/**
 * Every account currently has full ("admin") access — see `008_account.sql`
 * — so this repo is purely identity: who exists, and how each one proves it
 * is them. What they're allowed to do is not this table's concern.
 */
export const createAccountRepo = (db: Db): AccountRepo => {
  const selectById = db.prepare(`SELECT * FROM account WHERE id = ?`);
  const selectByUsername = db.prepare(`SELECT * FROM account WHERE username = ?`);
  const selectByOidc = db.prepare(
    `SELECT * FROM account WHERE oidc_issuer = ? AND oidc_subject = ?`,
  );
  const selectAll = db.prepare(`SELECT * FROM account ORDER BY created_at`);
  const selectCount = db.prepare(`SELECT COUNT(*) AS n FROM account`);

  const get = (id: string): AccountRecord | null => {
    const row = selectById.get(id) as AccountRow | undefined;
    return row === undefined ? null : toRecord(row);
  };

  const getByUsername = (username: string): AccountRecord | null => {
    const row = selectByUsername.get(username) as AccountRow | undefined;
    return row === undefined ? null : toRecord(row);
  };

  return {
    create(input) {
      if (getByUsername(input.username) !== null) {
        throw new DuplicateUsernameError(input.username);
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO account (id, username, password_hash, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, input.username, input.passwordHash, input.displayName ?? null, input.nowMs);
      const created = get(id);
      if (created === null) throw new Error(`Account ${id} vanished immediately after insert.`);
      return created;
    },

    createFromOidc(input) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO account (id, oidc_issuer, oidc_subject, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, input.oidcIssuer, input.oidcSubject, input.displayName ?? null, input.nowMs);
      const created = get(id);
      if (created === null) throw new Error(`Account ${id} vanished immediately after insert.`);
      return created;
    },

    getById: get,
    getByUsername,

    getByOidcIdentity(input) {
      const row = selectByOidc.get(input.issuer, input.subject) as AccountRow | undefined;
      return row === undefined ? null : toRecord(row);
    },

    list: () => (selectAll.all() as AccountRow[]).map(toRecord),

    count: () => (selectCount.get() as { n: number }).n,

    remove(id) {
      return db.prepare(`DELETE FROM account WHERE id = ?`).run(id).changes > 0;
    },

    setPassword(id, passwordHash) {
      db.prepare(`UPDATE account SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
    },

    touchLastLogin(id, nowMs) {
      db.prepare(`UPDATE account SET last_login_at = ? WHERE id = ?`).run(nowMs, id);
    },
  };
};
