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
 * The same API a shell script talks to, with the same key in the same header.
 *
 * NO COOKIE AND NO SESSION, deliberately. The spec's rule that the UI has no
 * privileged path only holds if the UI's credential is one a script could
 * also hold; and the event socket's security argument depends on there being
 * NO AMBIENT AUTHORITY in the browser — no cookie means a hostile page has
 * nothing to send and there is no CSRF shape to defend against.
 *
 * Everything durable comes through HERE. The event socket is liveness only:
 * a client that missed every frame must still be able to reconstruct the
 * whole truth by fetching, which is exactly what `api.test.ts`'s "a dropped
 * socket costs liveness, never correctness" asserts of the daemon. This
 * client must never become the reason that stops being true.
 */
export const createApiClient = (input: {
  baseUrl?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ApiClient => {
  const doFetch = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = input.baseUrl ?? '';

  const send = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await doFetch(`${base}${PREFIX}${path}`, {
      method,
      headers: {
        'X-Api-Key': input.apiKey,
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
 * The key goes in the QUERY STRING here and only here, because a browser
 * cannot set headers on a WebSocket upgrade. The daemon accepts both forms
 * for exactly this reason, and a WebSocket URL is never a Referer and never
 * lands in history — which is what makes this acceptable while the REST
 * client still uses the header.
 */
export const eventsUrl = (input: { baseUrl?: string; apiKey: string }): string => {
  const base = new URL(input.baseUrl ?? pageUrl());
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${PREFIX}/events`;
  base.search = `?apiKey=${encodeURIComponent(input.apiKey)}`;
  return base.toString();
};
