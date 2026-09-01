import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Only the network boundary is mocked: `discovery()` (a real HTTPS call to
 * the provider's `.well-known` document) and `authorizationCodeGrant()` (a
 * real HTTPS token exchange). Everything else `openid-client` does —
 * building the authorization URL, generating PKCE/state/nonce — runs for
 * real, which is what makes the transaction-cookie round trip below a
 * meaningful test rather than a mock talking to a mock.
 *
 * `discovery()` itself talks to a REAL local HTTP server (below) rather
 * than being stubbed out entirely: `buildAuthorizationUrl` refuses anything
 * that is not a genuine `Configuration` instance it minted, so the only way
 * to hand it one is to let discovery actually run — over plain HTTP, which
 * `openid-client` allows only via `allowInsecureRequests`, an escape hatch
 * this daemon's own `oidc.ts` never sets (production always speaks HTTPS
 * to a real issuer).
 */
const authorizationCodeGrant = vi.fn();
vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: (issuer: URL, clientId: string, clientSecret: string) =>
      actual.discovery(issuer, clientId, clientSecret, undefined, {
        execute: [actual.allowInsecureRequests],
      }),
    authorizationCodeGrant: (...args: unknown[]) => authorizationCodeGrant(...args),
  };
});
import { openDatabase, type Db } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createEventBus } from '../../daemon/events.js';
import type { ScanCoordinator } from '../../daemon/scan-coordinator.js';
import type { Supervisor, SupervisorStatus } from '../../daemon/supervisor.js';
import { createSettingsRepo, type SettingsRepo } from '../../db/settings-repo.js';
import { createApiContext, createApiServer } from '../server.js';
import { SESSION_COOKIE_NAME } from '../session.js';

// A real, current timestamp — not a fixed historical one. `jose`'s
// `jwtVerify` checks `exp` against the real wall clock, not an injectable
// "now", so a session token issued against a fixed-in-the-past `nowMs`
// would verify as already expired. See `session.test.ts` for the same fix.
const NOW = Date.now();
const API_KEY = 'the-fixed-test-api-key-000000';
const AUTH_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'trawlarr-auth-data-'));

/** A supervisor that does nothing; these routes never touch it. */
const fakeSupervisor = (): Supervisor => ({
  tick: async () => {
    await Promise.resolve();
  },
  status: (): SupervisorStatus => ({
    target: { transcode: 1, health: 0 },
    workers: [],
    paused: false,
  }),
  pause: () => {},
  resume: () => {},
  cancelJob: () => false,
  drain: async () => {
    await Promise.resolve();
  },
  stop: async () => {
    await Promise.resolve();
  },
});

/** A scan coordinator that does nothing; these routes never touch it. */
const fakeScans = (): ScanCoordinator => ({
  request: () => {},
  syncWatchers: () => {},
  idle: async () => {
    await Promise.resolve();
  },
  start: () => {},
  stop: async () => {
    await Promise.resolve();
  },
  scanning: () => [],
});

let db: Db;
let settings: SettingsRepo;
let server: Server;
let baseUrl: string;

interface Result {
  status: number;
  headers: Headers;
  body: unknown;
  cookies: Record<string, string>;
}

/**
 * Drives the API over a real socket, following no redirects itself — the
 * OIDC routes are tested by inspecting the redirect they hand back, not by
 * following it into a real provider.
 */
const api = async (
  method: string,
  path: string,
  options: { body?: unknown; apiKey?: string | null; cookie?: string | null } = {},
): Promise<Result> => {
  const key = options.apiKey === undefined ? API_KEY : options.apiKey;
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(key === null ? {} : { 'x-api-key': key }),
      ...(options.cookie === undefined || options.cookie === null
        ? {}
        : { cookie: options.cookie }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const cookies: Record<string, string> = {};
  for (const raw of setCookie) {
    const pair = raw.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    cookies[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? undefined : JSON.parse(text),
    cookies,
  };
};

beforeEach(async () => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  settings = createSettingsRepo({ db, generateApiKey: () => API_KEY });
  const ctx = createApiContext({
    db,
    settings,
    bus: createEventBus(),
    supervisor: fakeSupervisor(),
    scans: fakeScans(),
    nowMs: () => NOW,
    version: '0.0.0-test',
    dataDir: AUTH_TEST_DATA_DIR,
  });
  server = createApiServer(ctx, { onError: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('GET /auth/status', () => {
  it('says setup is required, and OIDC is off, on a fresh daemon', async () => {
    const { status, body } = await api('GET', '/auth/status', { apiKey: null });

    expect(status).toBe(200);
    expect(body).toEqual({ setupRequired: true, oidc: null });
  });

  it('says setup is done once an account exists', async () => {
    await api('POST', '/auth/setup', { body: { username: 'root', password: 'hunter22222' } });

    const { body } = await api('GET', '/auth/status', { apiKey: null });

    expect(body).toEqual({ setupRequired: false, oidc: null });
  });

  it('reports the OIDC display name once OIDC is enabled', async () => {
    settings.setAuth({
      oidcEnabled: true,
      oidcIssuer: 'https://idp.example.test/application/o/trawlarr/',
      oidcClientId: 'trawlarr',
      oidcClientSecret: 'secret',
      oidcRedirectUri: 'http://localhost:9999/api/v1/auth/oidc/callback',
      oidcDisplayName: 'Sign in with Authentik',
    });

    const { body } = await api('GET', '/auth/status', { apiKey: null });

    expect(body).toEqual({
      setupRequired: true,
      oidc: { displayName: 'Sign in with Authentik' },
    });
  });
});

describe('POST /auth/setup', () => {
  it('creates the first account and signs it in with a session cookie', async () => {
    const res = await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'root', loginMethod: 'password' });
    expect(res.cookies[SESSION_COOKIE_NAME]).toBeTruthy();
  });

  it('refuses a password under 8 characters', async () => {
    const res = await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'short' },
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid-body');
  });

  it('refuses to run again once an account exists', async () => {
    await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });

    const second = await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'someone-else', password: 'hunter22222' },
    });

    expect(second.status).toBe(409);
    expect((second.body as { error: { code: string } }).error.code).toBe('setup-already-complete');
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });
  });

  it('signs in with the right password and issues a session cookie', async () => {
    const res = await api('POST', '/auth/login', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: 'root' });
    expect(res.cookies[SESSION_COOKIE_NAME]).toBeTruthy();
  });

  it('refuses a wrong password without saying which part was wrong', async () => {
    const res = await api('POST', '/auth/login', {
      apiKey: null,
      body: { username: 'root', password: 'totally-wrong-password' },
    });

    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid-credentials');
  });

  it('refuses an unknown username with the identical error as a wrong password', async () => {
    const unknown = await api('POST', '/auth/login', {
      apiKey: null,
      body: { username: 'nobody', password: 'hunter22222' },
    });
    const wrong = await api('POST', '/auth/login', {
      apiKey: null,
      body: { username: 'root', password: 'totally-wrong-password' },
    });

    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe('a session cookie', () => {
  it('authorises requests that would otherwise need the API key', async () => {
    const login = await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });
    const cookie = `${SESSION_COOKIE_NAME}=${login.cookies[SESSION_COOKIE_NAME]}`;

    const libraries = await api('GET', '/libraries', { apiKey: null, cookie });

    expect(libraries.status).toBe(200);
  });

  it('reports who is signed in via GET /auth/session', async () => {
    const login = await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });
    const cookie = `${SESSION_COOKIE_NAME}=${login.cookies[SESSION_COOKIE_NAME]}`;

    const session = await api('GET', '/auth/session', { apiKey: null, cookie });

    expect(session.status).toBe(200);
    expect((session.body as { account: { username: string } }).account.username).toBe('root');
  });

  it('reports no account for an API-key request, rather than 401', async () => {
    const session = await api('GET', '/auth/session');

    expect(session.status).toBe(200);
    expect(session.body).toEqual({ account: null });
  });

  it('401s with no cookie and no API key, same as any other authenticated route', async () => {
    const session = await api('GET', '/auth/session', { apiKey: null });

    expect(session.status).toBe(401);
  });

  it('stops working the instant the account behind it is deleted', async () => {
    const login = await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });
    const cookie = `${SESSION_COOKIE_NAME}=${login.cookies[SESSION_COOKIE_NAME]}`;
    // A second account, so deleting the first is not refused as "the last account".
    await api('POST', '/auth/accounts', { body: { username: 'spare', password: 'hunter22222' } });
    const accountId = (login.body as { id: string }).id;

    await api('DELETE', `/auth/accounts/${accountId}`);
    const afterDelete = await api('GET', '/libraries', { apiKey: null, cookie });

    expect(afterDelete.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await api('POST', '/auth/logout', { apiKey: null });

    expect(res.status).toBe(204);
    expect(res.cookies[SESSION_COOKIE_NAME]).toBe('');
  });
});

describe('accounts', () => {
  it('lists every account, never a password hash', async () => {
    await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });

    const { body } = await api('GET', '/auth/accounts');

    expect(body).toMatchObject({ accounts: [{ username: 'root', loginMethod: 'password' }] });
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });

  it('creates additional accounts, all with equal access', async () => {
    await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });

    const res = await api('POST', '/auth/accounts', {
      body: { username: 'second', password: 'hunter22222' },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'second' });
  });

  it('refuses a duplicate username', async () => {
    await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });

    const res = await api('POST', '/auth/accounts', {
      body: { username: 'root', password: 'hunter22222' },
    });

    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('duplicate-username');
  });

  it('deletes an account that is not the last one', async () => {
    await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });
    const second = await api('POST', '/auth/accounts', {
      body: { username: 'second', password: 'hunter22222' },
    });

    const res = await api('DELETE', `/auth/accounts/${(second.body as { id: string }).id}`);

    expect(res.status).toBe(204);
  });

  it('refuses to delete the last account', async () => {
    const first = await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });

    const res = await api('DELETE', `/auth/accounts/${(first.body as { id: string }).id}`);

    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('last-account');
  });

  it('answers 404 for an account id that does not exist', async () => {
    await api('POST', '/auth/setup', {
      apiKey: null,
      body: { username: 'root', password: 'hunter22222' },
    });
    await api('POST', '/auth/accounts', { body: { username: 'second', password: 'hunter22222' } });

    const res = await api('DELETE', '/auth/accounts/does-not-exist');

    expect(res.status).toBe(404);
  });
});

describe('GET /auth/oidc/start', () => {
  it('answers 404 when OIDC is not enabled', async () => {
    const res = await api('GET', '/auth/oidc/start', { apiKey: null });

    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('oidc-disabled');
  });
});

describe('GET /auth/oidc/callback', () => {
  it('refuses a callback with no transaction cookie', async () => {
    settings.setAuth({
      oidcEnabled: true,
      oidcIssuer: 'https://idp.example.test/application/o/trawlarr/',
      oidcClientId: 'trawlarr',
      oidcClientSecret: 'secret',
      oidcRedirectUri: 'http://localhost:9999/api/v1/auth/oidc/callback',
    });

    const res = await api('GET', '/auth/oidc/callback?code=abc&state=xyz', { apiKey: null });

    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('oidc-transaction-expired');
  });

  it('answers 404 when OIDC is not enabled, even with a transaction cookie', async () => {
    const res = await api('GET', '/auth/oidc/callback?code=abc&state=xyz', {
      apiKey: null,
      cookie: 'trawlarr_oidc_txn=anything',
    });

    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('oidc-disabled');
  });
});

describe('a full OIDC round trip against a mocked provider', () => {
  // The provider's DISCOVERY DOCUMENT is served by a real local HTTP server
  // — see the module mock above for why `buildAuthorizationUrl` requires a
  // genuine, actually-discovered `Configuration`. The authorization endpoint
  // and token exchange the browser would otherwise be sent to are not real
  // (nothing here ever fetches them): only `authorizationCodeGrant` is
  // mocked, which is the one call that would perform that exchange.
  let providerServer: Server;
  let issuer: string;

  beforeEach(async () => {
    authorizationCodeGrant.mockReset();
    providerServer = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}authorize`,
            token_endpoint: `${issuer}token`,
            jwks_uri: `${issuer}jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}/`;
    settings.setAuth({
      oidcEnabled: true,
      oidcIssuer: issuer,
      oidcClientId: 'trawlarr',
      oidcClientSecret: 'secret',
      oidcRedirectUri: 'http://localhost:9999/api/v1/auth/oidc/callback',
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
  });

  it('provisions a new account on first login, then reuses it on the next', async () => {
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: 'idp-subject-1', name: 'Ada Lovelace' }),
    });

    const start = await api('GET', '/auth/oidc/start', { apiKey: null });
    expect(start.status).toBe(302);
    const txnCookie = `trawlarr_oidc_txn=${start.cookies.trawlarr_oidc_txn}`;

    const callback = await api('GET', '/auth/oidc/callback?code=abc&state=xyz', {
      apiKey: null,
      cookie: txnCookie,
    });

    expect(callback.status).toBe(302);
    expect(callback.cookies[SESSION_COOKIE_NAME]).toBeTruthy();
    expect(callback.cookies.trawlarr_oidc_txn).toBe('');

    const { body } = await api('GET', '/auth/accounts');
    expect(body).toMatchObject({
      accounts: [{ displayName: 'Ada Lovelace', loginMethod: 'oidc' }],
    });
    const firstAccountId = (body as { accounts: { id: string }[] }).accounts[0]!.id;

    // A second login from the same IdP subject must not create a second account.
    const start2 = await api('GET', '/auth/oidc/start', { apiKey: null });
    const txnCookie2 = `trawlarr_oidc_txn=${start2.cookies.trawlarr_oidc_txn}`;
    await api('GET', '/auth/oidc/callback?code=abc&state=xyz', {
      apiKey: null,
      cookie: txnCookie2,
    });

    const after = await api('GET', '/auth/accounts');
    expect((after.body as { accounts: { id: string }[] }).accounts).toHaveLength(1);
    expect((after.body as { accounts: { id: string }[] }).accounts[0]!.id).toBe(firstAccountId);
  });

  it('answers 500 when the token exchange fails, e.g. a state mismatch', async () => {
    authorizationCodeGrant.mockRejectedValue(new Error('state mismatch'));

    const start = await api('GET', '/auth/oidc/start', { apiKey: null });
    const txnCookie = `trawlarr_oidc_txn=${start.cookies.trawlarr_oidc_txn}`;

    const callback = await api('GET', '/auth/oidc/callback?code=abc&state=wrong', {
      apiKey: null,
      cookie: txnCookie,
    });

    expect(callback.status).toBe(500);
  });
});
