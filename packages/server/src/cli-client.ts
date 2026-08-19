import { API_KEY_HEADER } from './api/auth.js';
import { API_PREFIX } from './api/router.js';
import type { DaemonRecord } from './daemon/lockfile.js';

/**
 * A request the daemon refused, carrying the status and the message the
 * daemon wrote FOR THIS CALLER.
 *
 * Every API error body is `{error: {code, message}}` and every one of those
 * messages was composed to be read by a human, so the CLI prints it verbatim
 * rather than inventing a second wording that would drift from the API's.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(input: { status: number; code: string; message: string }) {
    super(input.message);
    this.name = 'ApiRequestError';
    this.status = input.status;
    this.code = input.code;
  }
}

/** The daemon could not be reached at all — a different failure from one it answered. */
export class DaemonUnreachableError extends Error {
  constructor(record: DaemonRecord, cause: unknown) {
    super(
      `The trawlarr daemon (pid ${String(record.pid)}) advertises its API on ` +
        `${record.bind}:${String(record.port)}, but nothing answered there: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Its lock file ` +
        `("daemon.json" in the data directory) still names a process that exists, so the CLI ` +
        `will not open the database behind its back — two writers on one library is how a ` +
        `replacement destroys data. Check that the daemon is healthy; if that pid is no longer ` +
        `trawlarr, stop it and start again.`,
      { cause },
    );
    this.name = 'DaemonUnreachableError';
  }
}

export interface CliClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

/**
 * The host a client dials, from the address the daemon BOUND.
 *
 * A daemon bound to `0.0.0.0` (or `::`) is listening on every interface, and
 * "every interface" is not an address anything can connect to — dialling it
 * literally fails on some platforms and reaches the wrong host on others. The
 * loopback address is always one of the interfaces such a daemon is on, and
 * it is the one a CLI running on the same machine (the only CLI that can read
 * the lock file at all) should use.
 */
export const clientHost = (bind: string): string => {
  if (bind === '0.0.0.0' || bind === '') return '127.0.0.1';
  if (bind === '::' || bind === '::0') return '::1';
  // A bare IPv6 literal has to be bracketed inside a URL.
  return bind.includes(':') ? `[${bind}]` : bind;
};

export const daemonBaseUrl = (record: DaemonRecord): string =>
  `http://${clientHost(record.bind)}:${String(record.port)}${API_PREFIX}`;

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}

/**
 * The CLI as a client of a running daemon.
 *
 * There is no second implementation of any rule here: every command that
 * routes through this is asking the daemon to do the thing it would
 * otherwise have done itself against the database, so the retention windows,
 * the pause explanations, the stale thresholds and the forget guards are all
 * the daemon's — one authority, whether or not a daemon is running.
 */
export const createCliClient = (
  record: DaemonRecord,
  options?: { fetchFn?: FetchLike },
): CliClient => {
  const base = daemonBaseUrl(record);
  const fetchFn: FetchLike = options?.fetchFn ?? ((input, init) => fetch(input, init));

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          [API_KEY_HEADER]: record.apiKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new DaemonUnreachableError(record, error);
    }

    const text = await response.text();
    if (!response.ok) {
      let code = 'http-error';
      let message = text === '' ? response.statusText : text;
      try {
        const parsed = JSON.parse(text) as ErrorBody;
        if (typeof parsed.error?.message === 'string') message = parsed.error.message;
        if (typeof parsed.error?.code === 'string') code = parsed.error.code;
      } catch {
        // A non-JSON error body (a proxy's HTML page, an empty 502) is
        // reported as its own text rather than being swallowed: the caller
        // still has to be told what went wrong.
      }
      throw new ApiRequestError({ status: response.status, code, message });
    }

    // 204, and any other empty body, is a legitimate answer — `undefined` is
    // what a caller expecting nothing gets, and `JSON.parse('')` would throw.
    return (text === '' ? undefined : JSON.parse(text)) as T;
  };

  return {
    get: async <T>(path: string): Promise<T> => await request<T>('GET', path),
    post: async <T>(path: string, body?: unknown): Promise<T> =>
      await request<T>('POST', path, body),
    patch: async <T>(path: string, body?: unknown): Promise<T> =>
      await request<T>('PATCH', path, body),
    put: async <T>(path: string, body?: unknown): Promise<T> => await request<T>('PUT', path, body),
    delete: async <T>(path: string): Promise<T> => await request<T>('DELETE', path),
  };
};
