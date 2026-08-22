import { describe, expect, it } from 'vitest';
import { bootstrapFromUrl, extractUrlKey, type HistoryLike } from './url-key.js';
import { createApiClient } from './client.js';
import { createKeyStore, type KeyStorage } from './key.js';

const memoryStorage = (): KeyStorage & { entries: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    entries: map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

const fakeHistory = (): HistoryLike & { calls: Array<string | URL | null | undefined> } => {
  const calls: Array<string | URL | null | undefined> = [];
  return {
    calls,
    replaceState: (_data, _unused, url) => {
      calls.push(url);
    },
  };
};

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

const headersOf = (call: Call): Record<string, string> =>
  call.init!.headers as Record<string, string>;

describe('extractUrlKey', () => {
  it('reads the apiKey query parameter and reports the URL with it removed', () => {
    const result = extractUrlKey('http://host/libraries?apiKey=secret-key-1234567890&x=1');
    expect(result).toEqual({
      key: 'secret-key-1234567890',
      strippedHref: 'http://host/libraries?x=1',
    });
  });

  it('returns null when there is no apiKey parameter', () => {
    expect(extractUrlKey('http://host/libraries?x=1')).toBeNull();
  });

  it('treats an empty apiKey value as absent, matching the key store', () => {
    expect(extractUrlKey('http://host/libraries?apiKey=')).toBeNull();
  });

  it('leaves the rest of the URL, including the path, untouched', () => {
    const result = extractUrlKey('http://host:8265/libraries/abc?apiKey=k');
    expect(result?.strippedHref).toBe('http://host:8265/libraries/abc');
  });
});

describe('bootstrapFromUrl', () => {
  const buildVerify = (
    reply: { status: number; body: unknown },
    calls: Call[] = [],
  ): ((key: string) => Promise<void>) => {
    return async (key: string) => {
      await createApiClient({ apiKey: key, fetchImpl: fetchStub(reply, calls) }).get(
        '/system/version',
      );
    };
  };

  it('does nothing when the URL carries no key', async () => {
    const history = fakeHistory();
    const store = createKeyStore(memoryStorage());

    const result = await bootstrapFromUrl({
      href: 'http://host/libraries',
      store,
      history,
      verify: async () => {
        throw new Error('verify should not be called');
      },
    });

    expect(result).toBeNull();
    expect(history.calls).toEqual([]);
    expect(store.read()).toBeNull();
  });

  it('verifies a valid URL key with X-Api-Key, stores it, and reports it', async () => {
    const history = fakeHistory();
    const store = createKeyStore(memoryStorage());
    const calls: Call[] = [];

    const result = await bootstrapFromUrl({
      href: 'http://host/libraries?apiKey=good-key-1234567890',
      store,
      history,
      verify: buildVerify({ status: 200, body: { version: '1.0.0' } }, calls),
    });

    expect(result).toEqual({ apiKey: 'good-key-1234567890', problem: null });
    expect(store.read()).toBe('good-key-1234567890');
    expect(calls[0]!.url).toBe('/api/v1/system/version');
    expect(headersOf(calls[0]!)['X-Api-Key']).toBe('good-key-1234567890');
  });

  it('strips the parameter from the URL as soon as it is seen, before verification resolves', async () => {
    const history = fakeHistory();
    const store = createKeyStore(memoryStorage());

    await bootstrapFromUrl({
      href: 'http://host/libraries?apiKey=good-key-1234567890&screen=libraries',
      store,
      history,
      verify: buildVerify({ status: 200, body: {} }),
    });

    expect(history.calls).toEqual(['http://host/libraries?screen=libraries']);
  });

  it('rejects an invalid URL key with a stated reason, never a silent failure', async () => {
    const history = fakeHistory();
    const store = createKeyStore(memoryStorage());

    const result = await bootstrapFromUrl({
      href: 'http://host/libraries?apiKey=bad-key-1234567890',
      store,
      history,
      verify: buildVerify({
        status: 401,
        body: { error: { code: 'unauthorized', message: 'no' } },
      }),
    });

    expect(result).toEqual({
      apiKey: null,
      problem: 'The key in that link was not accepted.',
    });
    expect(store.read()).toBeNull();
    // The address bar is still cleaned up even though the key was rejected.
    expect(history.calls).toEqual(['http://host/libraries']);
  });

  it('keeps an already-stored key rather than letting the URL replace it', async () => {
    const history = fakeHistory();
    const storage = memoryStorage();
    const store = createKeyStore(storage);
    store.write('stored-key-1234567890');
    const verifyCalls: Call[] = [];

    const result = await bootstrapFromUrl({
      href: 'http://host/libraries?apiKey=different-key-1234567890',
      store,
      history,
      verify: buildVerify({ status: 200, body: {} }, verifyCalls),
    });

    expect(result).toEqual({ apiKey: 'stored-key-1234567890', problem: null });
    // The URL key is never even checked: an already-signed-in browser has
    // nothing to gain from it and a stale or unwanted link could otherwise
    // sign it out or swap its key.
    expect(verifyCalls).toEqual([]);
    expect(store.read()).toBe('stored-key-1234567890');
    // But the URL is still cleaned up, since the key must not linger there
    // regardless of whether it was used.
    expect(history.calls).toEqual(['http://host/libraries']);
  });
});
