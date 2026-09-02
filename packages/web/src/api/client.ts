export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(input: { status: number; code: string; message: string }) {
    super(input.message);
    this.name = 'ApiClientError';
    this.status = input.status;
    this.code = input.code;
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
}

const PREFIX = '/api/v1';

/**
 * The same API a shell script talks to, with the same key in the same header
 * — for machine clients. A signed-in browser instead sends no API key and
 * relies on the httpOnly session cookie the daemon set at login, which
 * `credentials: 'same-origin'` is required to attach: fetch does not send
 * cookies by default for same-origin requests made from a module that could
 * in principle run in a stricter embedding context, and being explicit here
 * means this keeps working if that default ever changes upstream.
 *
 * Everything durable comes through HERE. The event socket is liveness only:
 * a client that missed every frame must still be able to reconstruct the
 * whole truth by fetching, which is exactly what `api.test.ts`'s "a dropped
 * socket costs liveness, never correctness" asserts of the daemon. This
 * client must never become the reason that stops being true.
 */
export const createApiClient = (input: {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): ApiClient => {
  const doFetch = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = input.baseUrl ?? '';

  const send = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await doFetch(`${base}${PREFIX}${path}`, {
      method,
      // Sent even for the API-key path: a machine client with no cookie to
      // begin with is unaffected, and it is what lets a signed-in browser's
      // session cookie ride along on every call through this one code path.
      credentials: 'same-origin',
      headers: {
        ...(input.apiKey === undefined ? {} : { 'X-Api-Key': input.apiKey }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 204) return undefined as T;
    if (!response.ok) {
      let code = 'unknown';
      let message = `The daemon answered ${String(response.status)}.`;
      try {
        const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        // A non-JSON body from a proxy in front of the daemon. Keep the
        // status-derived message rather than throwing a parse error over it.
      }
      throw new ApiClientError({ status: response.status, code, message });
    }
    return (await response.json()) as T;
  };

  return {
    get: async (path) => await send('GET', path),
    post: async (path, body) => await send('POST', path, body),
    patch: async (path, body) => await send('PATCH', path, body),
    put: async (path, body) => await send('PUT', path, body),
    del: async (path) => {
      await send<void>('DELETE', path);
    },
  };
};

/**
 * The page's own URL, read structurally.
 *
 * `globalThis.location` is a DOM global, and these files are typechecked
 * with lib ES2023 so they can join the one test gate. Reaching for it
 * through a narrow structural type keeps that possible and makes the
 * non-browser case an explicit, readable failure rather than
 * "cannot read properties of undefined".
 */
const pageUrl = (): string => {
  const location = (globalThis as { location?: { href?: string } }).location;
  if (location?.href === undefined) {
    throw new Error(
      'eventsUrl() was called outside a browser with no baseUrl. The socket URL is derived ' +
        "from the page's own origin, because the bundle is served same-origin by the daemon; " +
        'pass baseUrl explicitly when there is no page.',
    );
  }
  return location.href;
};

/**
 * The event socket's URL.
 *
 * `apiKey`, if given, goes in the QUERY STRING here and only here, because a
 * browser cannot set headers on a WebSocket upgrade. A signed-in browser
 * instead passes no `apiKey`: the upgrade request carries the same httpOnly
 * session cookie the browser attaches to every other same-origin request,
 * and the daemon accepts either credential on this path — see `ws.ts`'s
 * `onUpgrade`.
 */
export const eventsUrl = (input: { baseUrl?: string; apiKey?: string }): string => {
  const base = new URL(input.baseUrl ?? pageUrl());
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${PREFIX}/events`;
  base.search = input.apiKey === undefined ? '' : `?apiKey=${encodeURIComponent(input.apiKey)}`;
  return base.toString();
};
