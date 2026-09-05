import type { ApiClient } from '../api/client.js';

/**
 * Wraps a plain client so a 401 from ANY call signs the browser out.
 *
 * Pulled out of `useAuth` so it can be tested directly, with a fake `inner`
 * client, rather than only indirectly through a rendered hook — the same
 * reason `activity-model.ts` and friends exist as their own files.
 *
 * A ROTATED OR EXPIRED SESSION MUST BE RECOVERABLE FROM THE UI: this is the
 * one place that guarantee is enforced, for every verb, so a screen calling
 * `client.get`/`.post`/etc. never has to remember to check the status itself.
 */
export const guardClient = (
  inner: ApiClient,
  onUnauthorized: () => void | Promise<void>,
): ApiClient => {
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (caught) {
      const status = (caught as { status?: number }).status;
      if (status === 401) await onUnauthorized();
      throw caught;
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
};
