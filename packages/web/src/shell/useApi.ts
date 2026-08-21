import { useCallback, useMemo, useState } from 'react';
import { ApiClientError, createApiClient, type ApiClient } from '../api/client.js';
import { createKeyStore, type KeyStorage } from '../api/key.js';

const browserStorage = (): KeyStorage => {
  const storage = (globalThis as { localStorage?: KeyStorage }).localStorage;
  if (storage === undefined) {
    throw new Error(
      'useApi() needs localStorage to remember the API key. There is none on this globalThis; ' +
        'pass a KeyStorage explicitly when there is no browser.',
    );
  }
  return storage;
};

export interface ApiSession {
  /** Null until a key has been pasted; the gate is what renders in the meantime. */
  client: ApiClient | null;
  apiKey: string | null;
  setKey: (key: string) => void;
  signOut: () => void;
}

/**
 * The key, the client built from it, and the one way to lose both.
 *
 * A ROTATED KEY MUST BE RECOVERABLE FROM THE UI. Every call made through the
 * returned client is wrapped so that a 401 clears the stored key, which drops
 * the app back to the gate. Without this, rotating the daemon's key leaves a
 * browser stuck on an error screen whose only fix is deleting a localStorage
 * entry by hand — a fix nobody guesses.
 *
 * Any other error passes through untouched: a 404 or a 500 is the screen's
 * problem to render, and treating it as a credential failure would sign the
 * operator out over a bug.
 */
export const useApi = (storage: KeyStorage = browserStorage()): ApiSession => {
  const store = useMemo(() => createKeyStore(storage), [storage]);
  const [apiKey, setApiKey] = useState<string | null>(() => store.read());

  const signOut = useCallback(() => {
    store.clear();
    setApiKey(null);
  }, [store]);

  const client = useMemo<ApiClient | null>(() => {
    if (apiKey === null) return null;
    const inner = createApiClient({ apiKey });
    const guard = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 401) signOut();
        throw error;
      }
    };
    return {
      get: async <T>(path: string): Promise<T> => await guard(async () => await inner.get<T>(path)),
      post: async <T>(path: string, body?: unknown): Promise<T> =>
        await guard(async () => await inner.post<T>(path, body)),
      patch: async <T>(path: string, body: unknown): Promise<T> =>
        await guard(async () => await inner.patch<T>(path, body)),
      put: async <T>(path: string, body: unknown): Promise<T> =>
        await guard(async () => await inner.put<T>(path, body)),
      del: async (path: string): Promise<void> => {
        await guard(async () => {
          await inner.del(path);
        });
      },
    };
  }, [apiKey, signOut]);

  return {
    client,
    apiKey,
    setKey: (key) => {
      store.write(key);
      setApiKey(key);
    },
    signOut,
  };
};
