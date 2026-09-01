import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { DuplicateUsernameError, createAccountRepo, type AccountRepo } from './account-repo.js';

const NOW = 1_700_000_000_000;
let db: Db;
let repo: AccountRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createAccountRepo(db);
});

describe('create', () => {
  it('creates a password account with no OIDC identity', () => {
    const created = repo.create({
      username: 'admin',
      passwordHash: 'hash-1',
      displayName: 'Admin',
      nowMs: NOW,
    });
    expect(created).toMatchObject({
      username: 'admin',
      passwordHash: 'hash-1',
      displayName: 'Admin',
      oidcIssuer: null,
      oidcSubject: null,
      createdAt: NOW,
      lastLoginAt: null,
    });
  });

  it('rejects a duplicate username', () => {
    repo.create({ username: 'admin', passwordHash: 'hash-1', nowMs: NOW });
    expect(() => repo.create({ username: 'admin', passwordHash: 'hash-2', nowMs: NOW })).toThrow(
      DuplicateUsernameError,
    );
  });
});

describe('createFromOidc', () => {
  it('creates an account with no password', () => {
    const created = repo.createFromOidc({
      oidcIssuer: 'https://auth.example.com',
      oidcSubject: 'sub-123',
      displayName: 'Jane',
      nowMs: NOW,
    });
    expect(created).toMatchObject({
      username: null,
      passwordHash: null,
      oidcIssuer: 'https://auth.example.com',
      oidcSubject: 'sub-123',
    });
  });

  it('allows the same subject from two different issuers', () => {
    repo.createFromOidc({ oidcIssuer: 'https://a.example.com', oidcSubject: 'sub', nowMs: NOW });
    expect(() =>
      repo.createFromOidc({ oidcIssuer: 'https://b.example.com', oidcSubject: 'sub', nowMs: NOW }),
    ).not.toThrow();
  });

  it('rejects the same issuer/subject twice', () => {
    repo.createFromOidc({ oidcIssuer: 'https://a.example.com', oidcSubject: 'sub', nowMs: NOW });
    expect(() =>
      repo.createFromOidc({ oidcIssuer: 'https://a.example.com', oidcSubject: 'sub', nowMs: NOW }),
    ).toThrow();
  });
});

describe('lookups', () => {
  it('finds by id, username and OIDC identity', () => {
    const created = repo.create({ username: 'admin', passwordHash: 'hash', nowMs: NOW });
    expect(repo.getById(created.id)).toMatchObject({ username: 'admin' });
    expect(repo.getByUsername('admin')).toMatchObject({ id: created.id });
    expect(repo.getByUsername('nobody')).toBeNull();

    const oidc = repo.createFromOidc({
      oidcIssuer: 'https://auth.example.com',
      oidcSubject: 'sub-1',
      nowMs: NOW,
    });
    expect(
      repo.getByOidcIdentity({ issuer: 'https://auth.example.com', subject: 'sub-1' }),
    ).toMatchObject({
      id: oidc.id,
    });
    expect(
      repo.getByOidcIdentity({ issuer: 'https://auth.example.com', subject: 'nope' }),
    ).toBeNull();
  });

  it('lists and counts every account', () => {
    expect(repo.count()).toBe(0);
    repo.create({ username: 'a', passwordHash: 'h', nowMs: NOW });
    repo.create({ username: 'b', passwordHash: 'h', nowMs: NOW });
    expect(repo.count()).toBe(2);
    expect(repo.list().map((a) => a.username)).toEqual(['a', 'b']);
  });
});

describe('mutation', () => {
  it('removes an account', () => {
    const created = repo.create({ username: 'admin', passwordHash: 'hash', nowMs: NOW });
    expect(repo.remove(created.id)).toBe(true);
    expect(repo.getById(created.id)).toBeNull();
    expect(repo.remove(created.id)).toBe(false);
  });

  it('updates the password hash', () => {
    const created = repo.create({ username: 'admin', passwordHash: 'old', nowMs: NOW });
    repo.setPassword(created.id, 'new');
    expect(repo.getById(created.id)).toMatchObject({ passwordHash: 'new' });
  });

  it('records the last login time', () => {
    const created = repo.create({ username: 'admin', passwordHash: 'hash', nowMs: NOW });
    repo.touchLastLogin(created.id, NOW + 1000);
    expect(repo.getById(created.id)).toMatchObject({ lastLoginAt: NOW + 1000 });
  });
});
