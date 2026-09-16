/**
 * A recording `ApiClient` for the component tests.
 *
 * Every screen in this package takes its `client` as a prop, so a component
 * test never has to reach past the component for its data: there is no
 * `fetch` to stub, no module to mock, and nothing global to restore. What is
 * asserted is the same thing the daemon would see — which requests were made,
 * in what ORDER, with what bodies — against a component rendering real DOM.
 *
 * Order is the whole point for the Nodes tab: the defects this harness exists
 * to catch were all "the mutation answered, and the screen believed the
 * answer instead of re-reading the list". `calls` is append-only and
 * `signatures()` flattens it, so "the list was re-fetched AFTER the PUT" is a
 * literal assertion rather than a count.
 */

import { ApiClientError, type ApiClient } from '../api/client.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RecordedCall {
  method: HttpMethod;
  path: string;
  /** The parsed request body, or `undefined` for GET/DELETE. */
  body: unknown;
}

/**
 * A route's answer. A plain value is returned as-is; a function is called
 * with the request body on every hit, which is how a test makes `GET /nodes`
 * answer differently before and after a mutation (and how it makes one
 * request fail without affecting the others).
 */
export type RouteHandler = (body: unknown) => unknown;
/**
 * Spelled as a union of concrete JSON shapes rather than `unknown | Handler`:
 * `unknown` absorbs every other member of a union, so that spelling left a
 * route handler's `body` parameter implicitly `any` and `pnpm typecheck`
 * rejected it.
 */
export type RouteAnswer =
  RouteHandler | Record<string, unknown> | readonly unknown[] | string | number | boolean | null;

export interface FakeApiClient extends ApiClient {
  /** Every request this client was asked to make, oldest first. */
  readonly calls: RecordedCall[];
  /** `calls` as `"GET /nodes"` strings — what order assertions read. */
  signatures(): string[];
  /** Replace or add a route mid-test. */
  route(signature: string, answer: RouteAnswer): void;
}

/**
 * Routes are keyed `"<METHOD> <path>"`, e.g. `'GET /nodes'`. An unrouted
 * request throws a 404 `ApiClientError` rather than resolving `undefined`:
 * a screen that quietly starts calling a new endpoint should fail its test,
 * not render half a page with no explanation.
 */
export const createFakeClient = (routes: Record<string, RouteAnswer>): FakeApiClient => {
  const table = new Map(Object.entries(routes));
  const calls: RecordedCall[] = [];

  const send = async (method: HttpMethod, path: string, body?: unknown): Promise<unknown> => {
    calls.push({ method, path, body });
    const signature = `${method} ${path}`;
    if (!table.has(signature)) {
      throw new ApiClientError({
        status: 404,
        code: 'not_found',
        message: `No fake route for ${signature}.`,
      });
    }
    const answer = table.get(signature);
    // `await` so a handler may return a rejected promise to simulate a failure.
    return await (typeof answer === 'function' ? answer(body) : answer);
  };

  return {
    calls,
    signatures: () => calls.map((call) => `${call.method} ${call.path}`),
    route: (signature, answer) => {
      table.set(signature, answer);
    },
    get: async (path) => (await send('GET', path)) as never,
    post: async (path, body) => (await send('POST', path, body)) as never,
    patch: async (path, body) => (await send('PATCH', path, body)) as never,
    put: async (path, body) => (await send('PUT', path, body)) as never,
    del: async (path) => {
      await send('DELETE', path);
    },
  };
};
