import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClientError, createApiClient, type ApiClient } from '../api/client.js';
import { createKeyStore, type KeyStorage } from '../api/key.js';
import { bootstrapFromUrl, verifyKeyAgainstServer, type HistoryLike } from '../api/url-key.js';

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

/**
 * Where `bootstrapFromUrl` reads the page's URL and rewrites it. `null`
 * outside a browser (no `location`/`history`), which `useApi` reads as
 * "there is no `?apiKey=` to look for" rather than throwing — unlike
 * `browserStorage()`, a missing URL environment is not a caller error.
 */
const browserUrlEnv = (): { href: string; history: HistoryLike } | null => {
  const location = (globalThis as { location?: { href?: string } }).location;
  const history = (globalThis as { history?: HistoryLike }).history;
  if (location?.href === undefined || history === undefined) return null;
  return { href: location.href, history };
};

export interface ApiSession {
  /** Null until a key has been pasted; the gate is what renders in the meantime. */
  client: ApiClient | null;
  apiKey: string | null;
  /**
   * Set when a `?apiKey=` on the URL was checked and rejected. `KeyGate`
   * shows this instead of the blank form a silently-ignored bad link would
   * otherwise leave behind.
   */
  urlKeyProblem: string | null;
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
export const useApi = (
  storage: KeyStorage = browserStorage(),
  // A FUNCTION, not the environment itself: `browserUrlEnv()` builds a new
  // object every time it runs, and a default *parameter* is re-evaluated on
  // every render this hook makes with no explicit argument. Passing the
  // function keeps the default a stable reference (it is declared once, at
  // module scope) so the effect below runs once rather than on every render.
  getUrlEnv: () => { href: string; history: HistoryLike } | null = browserUrlEnv,
): ApiSession => {
  const store = useMemo(() => createKeyStore(storage), [storage]);
  const [apiKey, setApiKey] = useState<string | null>(() => store.read());
  const [urlKeyProblem, setUrlKeyProblem] = useState<string | null>(null);

  const signOut = useCallback(() => {
    store.clear();
    setApiKey(null);
  }, [store]);

  useEffect(() => {
    const urlEnv = getUrlEnv();
    if (urlEnv === null) return;
    void bootstrapFromUrl({
      href: urlEnv.href,
      store,
      history: urlEnv.history,
      verify: verifyKeyAgainstServer,
    }).then((result) => {
      if (result === null) return;
      if (result.apiKey !== null) setApiKey(result.apiKey);
      setUrlKeyProblem(result.problem);
    });
  }, [getUrlEnv, store]);

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
    urlKeyProblem,
    setKey: (key) => {
      store.write(key);
      setApiKey(key);
    },
    signOut,
  };
};
