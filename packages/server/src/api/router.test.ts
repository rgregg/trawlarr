import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/connection.js';
import { createEventBus } from '../daemon/events.js';
import type { ScanCoordinator } from '../daemon/scan-coordinator.js';
import type { PluginSyncCoordinator } from '../plugins/sync-coordinator.js';
import type { Supervisor } from '../daemon/supervisor.js';
import type { SettingsRepo } from '../db/settings-repo.js';
import { ApiError, created, noContent, type ApiContext, type Route } from './router.js';
import { createApiHandler } from './server.js';

const API_KEY = 'a-test-api-key-0123456789';

const stubSettings = (): SettingsRepo =>
  ({
    getDaemon: () => ({ bind: '127.0.0.1', port: 8265, apiKey: API_KEY }),
  }) as unknown as SettingsRepo;

const stubContext = (over: Partial<ApiContext> = {}): ApiContext => ({
  db: {} as Db,
  settings: stubSettings(),
  bus: createEventBus(),
  supervisor: {} as Supervisor,
  scans: {} as ScanCoordinator,
  pluginSyncs: {} as PluginSyncCoordinator,
  dataDir: '/nonexistent-data-dir',
  nowMs: () => 1_700_000_000_000,
  version: '0.0.0-test',
  schemaVersion: 4,
  envApplications: [],
  hardwareFindings: [],
  ...over,
});

interface TestResponse {
  status: number;
  headers: Record<string, string>;
  raw: string;
  body: unknown;
}

/**
 * Drives `createApiHandler` the way `node:http` drives it — a readable
 * request, a response object it writes a status, headers and one body to —
 * without opening a socket. `api.test.ts` covers the real socket; this file
 * covers the shapes that are awkward to produce over one (a body that is not
 * JSON, a method nothing registered).
 */
const request = async (
  ctx: ApiContext,
  method: string,
  path: string,
  options: {
    body?: unknown;
    rawBody?: string;
    apiKey?: string | null;
    routes?: Route[];
    /**
     * Defaults to `null` — "this daemon has no web bundle". Pinned rather
     * than resolved, so these router assertions do not change meaning
     * depending on whether the checkout running them happens to have run
     * the web build.
     */
    webRoot?: string | null;
  } = {},
): Promise<TestResponse> => {
  const payload =
    options.rawBody ?? (options.body === undefined ? '' : JSON.stringify(options.body));
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload)]) as IncomingMessage;
  req.method = method;
  req.url = path;
  const key = options.apiKey === undefined ? API_KEY : options.apiKey;
  req.headers = key === null ? {} : { 'x-api-key': key };

  const headers: Record<string, string> = {};
  let status = 0;
  let raw = '';

  return await new Promise<TestResponse>((resolve) => {
    const res = {
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(code: number, extra?: Record<string, string>) {
        status = code;
        for (const [name, value] of Object.entries(extra ?? {})) {
          headers[name.toLowerCase()] = value;
        }
        return res;
      },
      end(chunk?: string) {
        raw = chunk ?? '';
        resolve({ status, headers, raw, body: raw === '' ? undefined : JSON.parse(raw) });
      },
    } as unknown as ServerResponse;

    createApiHandler(ctx, {
      routes: options.routes,
      onError: () => {},
      webRoot: options.webRoot ?? null,
    })(req, res);
  });
};

describe('the router', () => {
  it('binds a :param segment to the value in the path', async () => {
    let seen: Record<string, string> | null = null;
    const routes: Route[] = [
      {
        method: 'GET',
        path: '/libraries/:id',
        handler: ({ params }) => {
          seen = params;
          return { ok: true };
        },
      },
    ];

    const response = await request(stubContext(), 'GET', '/api/v1/libraries/abc', { routes });

    expect(response.status).toBe(200);
    expect(seen).toEqual({ id: 'abc' });
  });

  it('prefers the literal route over the parameterised one, whatever order they are declared in', async () => {
    const routes: Route[] = [
      { method: 'GET', path: '/plugins/:id', handler: () => ({ matched: 'param' }) },
      { method: 'GET', path: '/plugins/sources', handler: () => ({ matched: 'literal' }) },
    ];

    const literal = await request(stubContext(), 'GET', '/api/v1/plugins/sources', { routes });
    const param = await request(stubContext(), 'GET', '/api/v1/plugins/trawlarr:start', { routes });

    expect(literal.body).toEqual({ matched: 'literal' });
    expect(param.body).toEqual({ matched: 'param' });
  });

  it('answers an unknown path with a JSON 404, not an empty body and not HTML', async () => {
    const response = await request(stubContext(), 'GET', '/api/v1/nope');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'not-found' } });
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.raw).not.toContain('<html');
  });

  it('hands a path outside the version prefix to the web bundle, not to the router', async () => {
    // `/libraries` is a CLIENT-SIDE route now. The router must not claim it,
    // and a daemon with no bundle must say why rather than return a
    // `not-found` that reads like the API lost an endpoint.
    const response = await request(stubContext(), 'GET', '/libraries');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: 'web-ui-not-built' } });
  });

  it('answers an unparseable body with 400 bad-json, and never calls the handler', async () => {
    let called = false;
    const routes: Route[] = [
      {
        method: 'POST',
        path: '/libraries',
        handler: () => {
          called = true;
          return {};
        },
      },
    ];

    const response = await request(stubContext(), 'POST', '/api/v1/libraries', {
      rawBody: '{',
      routes,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'bad-json' } });
    expect(called).toBe(false);
  });

  it('answers a method nothing registered with 405 and an Allow header listing what exists', async () => {
    const routes: Route[] = [
      { method: 'GET', path: '/libraries/:id', handler: () => ({}) },
      { method: 'PATCH', path: '/libraries/:id', handler: () => ({}) },
    ];

    const response = await request(stubContext(), 'DELETE', '/api/v1/libraries/abc', { routes });

    expect(response.status).toBe(405);
    expect(response.body).toMatchObject({ error: { code: 'method-not-allowed' } });
    expect(response.headers.allow).toBe('GET, PATCH');
  });
});

describe('authentication', () => {
  it('answers a request with no key and a request with the wrong key identically', async () => {
    const missing = await request(stubContext(), 'GET', '/api/v1/libraries', { apiKey: null });
    const wrong = await request(stubContext(), 'GET', '/api/v1/libraries', {
      apiKey: 'not-the-key-at-all-000000',
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    // Byte-identical: a different message for "missing" versus "wrong" tells
    // an attacker which half of the problem they have already solved.
    expect(wrong.raw).toBe(missing.raw);
    expect(missing.body).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects a key that is a prefix of the real one', async () => {
    const response = await request(stubContext(), 'GET', '/api/v1/libraries', {
      apiKey: API_KEY.slice(0, 8),
    });

    expect(response.status).toBe(401);
  });

  it('serves GET /system/health with no key at all, so a health check needs no secret', async () => {
    const response = await request(stubContext(), 'GET', '/api/v1/system/health', {
      apiKey: null,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', schemaVersion: 4 });
  });

  it('still requires a key for every other system route', async () => {
    const response = await request(stubContext(), 'GET', '/api/v1/system/settings', {
      apiKey: null,
    });

    expect(response.status).toBe(401);
  });
});

describe('error shaping', () => {
  it('never leaks a stack trace or an internal message in an error body', async () => {
    const ctx = stubContext({
      // The real GET /libraries handler builds a repo from this db, which
      // prepares its statements immediately — so this is the failure a
      // corrupt database actually produces on that route.
      db: {
        prepare: () => {
          throw new Error('SQLITE_CORRUPT: /data/trawlarr.db');
        },
      } as unknown as Db,
    });

    const response = await request(ctx, 'GET', '/api/v1/libraries');

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/ at .*\.ts:/);
    expect(JSON.stringify(response.body)).not.toContain('/data/trawlarr.db');
    expect(response.body).toMatchObject({ error: { code: 'internal-error' } });
  });

  it('returns an ApiError message verbatim, because it was written for the caller', async () => {
    const routes: Route[] = [
      {
        method: 'GET',
        path: '/libraries/:id',
        handler: () => {
          throw new ApiError(404, 'library-not-found', 'No library with id "abc".');
        },
      },
    ];

    const response = await request(stubContext(), 'GET', '/api/v1/libraries/abc', { routes });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'library-not-found', message: 'No library with id "abc".' },
    });
  });

  it('reports the status a handler asked for, and sends no body for 204', async () => {
    const routes: Route[] = [
      { method: 'POST', path: '/flows', handler: () => created({ id: 'flow-1' }) },
      { method: 'DELETE', path: '/flows/:id', handler: () => noContent() },
    ];

    const createdResponse = await request(stubContext(), 'POST', '/api/v1/flows', { routes });
    const deleted = await request(stubContext(), 'DELETE', '/api/v1/flows/flow-1', { routes });

    expect(createdResponse.status).toBe(201);
    expect(createdResponse.body).toEqual({ id: 'flow-1' });
    expect(deleted.status).toBe(204);
    expect(deleted.raw).toBe('');
  });
});
