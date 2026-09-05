import { describe, expect, it } from 'vitest';
import {
  createFirstAccount,
  fetchAuthStatus,
  fetchSession,
  login,
  logout,
  oidcStartUrl,
} from './session.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const fetchStub = (reply: { status: number; body: unknown }, calls: Call[] = []): typeof fetch =>
  (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => await Promise.resolve(reply.body),
    } as Response;
  }) as unknown as typeof fetch;

// `createApiClient` reads `globalThis.fetch` when no `fetchImpl` is given,
// and `session.ts`'s helpers never expose a way to inject one — they are
// meant to be called with nothing but a `baseUrl`, same as a real caller
// would. Stubbing the global here is what keeps that surface honest while
// still letting these tests assert on the exact request each helper made.
const withStubbedFetch = async <T>(
  reply: { status: number; body: unknown },
  run: (calls: Call[]) => Promise<T>,
): Promise<{ result: T; calls: Call[] }> => {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = fetchStub(reply, calls);
  try {
    const result = await run(calls);
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
};

describe('fetchAuthStatus', () => {
  it('reports setup-required and no SSO for a fresh daemon', async () => {
    const { result, calls } = await withStubbedFetch(
      { status: 200, body: { setupRequired: true, oidc: null } },
      async () => await fetchAuthStatus(),
    );

    expect(calls[0]!.url).toBe('/api/v1/auth/status');
    expect(result).toEqual({ setupRequired: true, oidc: null });
  });

  it('carries the SSO display name through when OIDC is configured', async () => {
    const { result } = await withStubbedFetch(
      { status: 200, body: { setupRequired: false, oidc: { displayName: 'Authentik' } } },
      async () => await fetchAuthStatus(),
    );

    expect(result.oidc).toEqual({ displayName: 'Authentik' });
  });
});

describe('fetchSession', () => {
  it('returns null rather than throwing when nobody is signed in', async () => {
    const { result } = await withStubbedFetch(
      { status: 200, body: { account: null } },
      async () => await fetchSession(),
    );

    expect(result).toBeNull();
  });

  it('returns the account when a session cookie is valid', async () => {
    const account = {
      id: 'acc-1',
      username: 'root',
      displayName: null,
      loginMethod: 'password' as const,
      createdAt: 1,
      lastLoginAt: 2,
    };
    const { result } = await withStubbedFetch(
      { status: 200, body: { account } },
      async () => await fetchSession(),
    );

    expect(result).toEqual(account);
  });
});

describe('createFirstAccount', () => {
  it('posts to /auth/setup with the given credentials', async () => {
    const account = {
      id: 'acc-1',
      username: 'root',
      displayName: null,
      loginMethod: 'password' as const,
      createdAt: 1,
      lastLoginAt: null,
    };
    const { result, calls } = await withStubbedFetch(
      { status: 201, body: account },
      async () => await createFirstAccount({ username: 'root', password: 'hunter22' }),
    );

    expect(calls[0]!.url).toBe('/api/v1/auth/setup');
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.init!.body).toBe('{"username":"root","password":"hunter22"}');
    expect(result).toEqual(account);
  });
});

describe('login', () => {
  it('posts to /auth/login with the given credentials', async () => {
    const account = {
      id: 'acc-1',
      username: 'root',
      displayName: null,
      loginMethod: 'password' as const,
      createdAt: 1,
      lastLoginAt: 3,
    };
    const { calls, result } = await withStubbedFetch(
      { status: 200, body: account },
      async () => await login({ username: 'root', password: 'hunter22' }),
    );

    expect(calls[0]!.url).toBe('/api/v1/auth/login');
    expect(result).toEqual(account);
  });

  it('rejects with the daemon error on a bad password', async () => {
    await expect(
      withStubbedFetch(
        { status: 401, body: { error: { code: 'invalid-credentials', message: 'no' } } },
        async () => await login({ username: 'root', password: 'wrong' }),
      ),
    ).rejects.toMatchObject({ status: 401, code: 'invalid-credentials' });
  });
});

describe('logout', () => {
  it('posts to /auth/logout', async () => {
    const { calls } = await withStubbedFetch(
      { status: 204, body: null },
      async () => await logout(),
    );

    expect(calls[0]!.url).toBe('/api/v1/auth/logout');
    expect(calls[0]!.init!.method).toBe('POST');
  });
});

describe('oidcStartUrl', () => {
  it('encodes returnTo as a query parameter on the start endpoint', () => {
    expect(oidcStartUrl({ returnTo: '/libraries' })).toBe(
      '/api/v1/auth/oidc/start?returnTo=%2Flibraries',
    );
  });

  it('prefixes a baseUrl the same way the API client does', () => {
    expect(oidcStartUrl({ returnTo: '/', baseUrl: 'http://127.0.0.1:8265' })).toBe(
      'http://127.0.0.1:8265/api/v1/auth/oidc/start?returnTo=%2F',
    );
  });
});
