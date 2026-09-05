import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Db } from '../db/connection.js';
import type { EventBus } from '../daemon/events.js';
import type { ScanCoordinator } from '../daemon/scan-coordinator.js';
import {
  createPluginSyncCoordinator,
  type PluginSyncCoordinator,
} from '../plugins/sync-coordinator.js';
import type { Supervisor } from '../daemon/supervisor.js';
import { SCHEMA_VERSION } from '../db/migrate.js';
import type { SettingsRepo } from '../db/settings-repo.js';
import type { EnvApplication } from '../config/env-settings.js';
import type { HardwareFinding } from '../daemon/hardware-preflight.js';
import { API_KEY_HEADER, isAuthorised, unauthorized } from './auth.js';
import { parseCookies, verifySessionToken, SESSION_COOKIE_NAME } from './session.js';
import { createAccountRepo, type AccountRepo } from '../db/account-repo.js';
import { authRoutes } from './routes/auth.js';
import { createStaticHandler, resolveWebRoot } from './static-files.js';
import { fileRoutes } from './routes/files.js';
import { flowRoutes } from './routes/flows.js';
import { jobRoutes } from './routes/jobs.js';
import { libraryRoutes } from './routes/libraries.js';
import { ensureLocalNode, nodeRoutes } from './routes/nodes.js';
import { pluginRoutes } from './routes/plugins.js';
import { systemRoutes } from './routes/system.js';
import { workerRoutes } from './routes/workers.js';
import {
  API_PREFIX,
  ApiError,
  ApiResponse,
  createRouter,
  type ApiContext,
  type Route,
} from './router.js';

/**
 * Every route, in the order spec 3.5 lists its groups. Matching is by
 * SPECIFICITY, not by position in this array (see `createRouter`), so this
 * order is documentation and nothing else.
 */
export const ALL_ROUTES: Route[] = [
  ...systemRoutes,
  ...authRoutes,
  ...libraryRoutes,
  ...fileRoutes,
  ...flowRoutes,
  ...pluginRoutes,
  ...jobRoutes,
  ...nodeRoutes,
  ...workerRoutes,
];

/**
 * The largest request body accepted.
 *
 * A flow definition is the biggest thing anyone legitimately POSTs here and
 * is measured in kilobytes. Without a cap, a single request can buffer
 * unbounded memory in the process that also holds the database — so the cap
 * is the difference between a bad request and an OOM kill that takes the
 * daemon and every running transcode with it.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const errorBody = (code: string, message: string): string =>
  JSON.stringify({ error: { code, message } });

/**
 * The message a non-`ApiError` becomes.
 *
 * Deliberately says nothing about what actually happened: an internal error's
 * text carries database paths, sql fragments and filesystem layout, and an
 * HTTP client is not the right audience for any of it. The daemon's log is.
 */
const INTERNAL_ERROR_MESSAGE =
  `The daemon failed to handle this request. The reason was logged on the server; it is ` +
  `deliberately not returned here, because an internal error's text names paths and internals a ` +
  `client should never be handed. If this is reproducible, the daemon log holds the detail.`;

class BodyTooLargeError extends Error {}

const readBody = async (req: IncomingMessage): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });

export interface CreateApiHandlerOptions {
  /** Substitute the route table. Tests only; production always uses ALL_ROUTES. */
  routes?: Route[];
  /** Where an internal (non-`ApiError`) failure is reported. Defaults to stderr. */
  onError?: (error: unknown, context: { method: string; path: string }) => void;
  /**
   * Where the built web bundle lives. Omitted means "look for it"
   * ({@link resolveWebRoot}); an explicit `null` means "there is none", which
   * is how a test asks for a daemon that serves the API and nothing else.
   */
  webRoot?: string | null;
}

/**
 * The whole HTTP surface, as one request handler.
 *
 * Built on `node:http` with a hand-rolled router: the routing need is a
 * twenty-line table, and a framework would be a dependency to licence-audit,
 * update and trust for no behaviour this API does not already have. Every
 * response is JSON; every failure is `{error: {code, message}}` with a real
 * status code, because an API that returns 200 with an error body is one no
 * client can branch on.
 *
 * NOTHING THROWS OUT OF HERE. A handler that throws, a body that is not
 * JSON, a socket that dies mid-read — each becomes a status code and a JSON
 * body. An unhandled rejection in a request handler would take down the
 * daemon, and with it every transcode it is supervising.
 */
export const createApiHandler = (
  ctx: ApiContext,
  options?: CreateApiHandlerOptions,
): ((req: IncomingMessage, res: ServerResponse) => void) => {
  const router = createRouter(options?.routes ?? ALL_ROUTES);
  const onError =
    options?.onError ??
    ((error: unknown, context: { method: string; path: string }): void => {
      console.error(
        `[api] ${context.method} ${context.path} failed:`,
        error instanceof Error ? error.stack : error,
      );
    });

  // Built once, consulted first. It answers `false` for every path under
  // API_PREFIX, so the API becomes unreachable only through a bug in that
  // single check — which `api.test.ts` pins against the real server.
  const serveStatic = createStaticHandler({
    root: options?.webRoot === undefined ? resolveWebRoot() : options.webRoot,
  });

  const send = (
    res: ServerResponse,
    status: number,
    payload: string | null,
    headers?: Record<string, string | string[]>,
  ): void => {
    if (headers !== undefined) {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    }
    if (payload === null) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
    });
    res.end(payload);
  };

  const isSecureRequest = (req: IncomingMessage): boolean => {
    if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted === true) return true;
    const forwarded = req.headers['x-forwarded-proto'];
    const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return proto?.split(',')[0]?.trim().toLowerCase() === 'https';
  };

  /**
   * Is this browser signed in? A valid session cookie is not enough on its
   * own: the account it names must still exist, so that deleting an account
   * ends every session it ever issued, immediately — a JWT with no
   * server-side session store has no other way to be revoked.
   */
  const isSessionAuthorised = async (input: {
    cookies: Record<string, string>;
    ctx: ApiContext;
  }): Promise<boolean> => {
    const token = input.cookies[SESSION_COOKIE_NAME];
    if (token === undefined) return false;
    const accountId = await verifySessionToken({
      token,
      secret: input.ctx.settings.getAuth().sessionSecret,
    });
    if (accountId === null) return false;
    return input.ctx.accounts.getById(accountId) !== null;
  };

  return (req, res) => {
    if (serveStatic(req, res)) return;
    void (async () => {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const cookies = parseCookies(req.headers.cookie);
      const secure = isSecureRequest(req);

      try {
        const matched = router.match(method, pathname);

        if (matched.kind === 'not-found') {
          send(
            res,
            404,
            errorBody(
              'not-found',
              `No route for ${method} ${pathname}. Every endpoint lives under ` +
                `${API_PREFIX}; GET ${API_PREFIX}/system/version reports what this build is.`,
            ),
          );
          return;
        }

        if (matched.kind === 'method-not-allowed') {
          res.setHeader('allow', matched.allow.join(', '));
          send(
            res,
            405,
            errorBody(
              'method-not-allowed',
              `${method} is not supported for ${pathname}. It accepts: ` +
                `${matched.allow.join(', ')}.`,
            ),
          );
          return;
        }

        if (matched.route.anonymous !== true) {
          const header = req.headers[API_KEY_HEADER];
          const provided = Array.isArray(header) ? header[0] : header;
          const apiKeyOk = isAuthorised({ provided, expected: ctx.settings.getDaemon().apiKey });
          const sessionOk = apiKeyOk ? false : await isSessionAuthorised({ cookies, ctx });
          if (!apiKeyOk && !sessionOk) {
            const error = unauthorized();
            send(res, error.status, errorBody(error.code, error.message));
            return;
          }
        }

        let body: unknown;
        const raw = await readBody(req);
        if (raw !== '') {
          try {
            body = JSON.parse(raw);
          } catch {
            send(
              res,
              400,
              errorBody(
                'bad-json',
                `The request body is not valid JSON. Every endpoint here takes and returns ` +
                  `JSON; send "content-type: application/json" and a parseable body.`,
              ),
            );
            return;
          }
        }

        const result = await matched.route.handler({
          params: matched.params,
          query: url.searchParams,
          body,
          ctx,
          cookies,
          secure,
        });

        if (result instanceof ApiResponse) {
          send(
            res,
            result.status,
            result.body === null ? null : JSON.stringify(result.body),
            result.headers,
          );
          return;
        }
        send(res, 200, JSON.stringify(result ?? null));
      } catch (error) {
        if (error instanceof ApiError) {
          // An ApiError's message was written for this caller: returned
          // verbatim, with the status and code it chose.
          send(res, error.status, errorBody(error.code, error.message));
          return;
        }
        if (error instanceof BodyTooLargeError) {
          send(
            res,
            413,
            errorBody(
              'payload-too-large',
              `The request body exceeds ${String(MAX_BODY_BYTES)} bytes. Nothing this API ` +
                `accepts is that big; the cap exists so one request cannot exhaust the memory ` +
                `of the process supervising every running transcode.`,
            ),
          );
          return;
        }
        // Everything else is flattened. The detail goes to the log, never
        // to the client — see INTERNAL_ERROR_MESSAGE.
        onError(error, { method, path: pathname });
        send(res, 500, errorBody('internal-error', INTERNAL_ERROR_MESSAGE));
      }
    })();
  };
};

export interface CreateApiContextInput {
  db: Db;
  settings: SettingsRepo;
  bus: EventBus;
  supervisor: Supervisor;
  scans: ScanCoordinator;
  /** The data directory this daemon owns; plugin sources are installed under it. */
  dataDir: string;
  nowMs?: () => number;
  version: string;
  checkBinary?: (path: string) => Promise<boolean>;
  /** What each seed-once environment variable did on this start. Defaults to none. */
  envApplications?: EnvApplication[];
  /**
   * What the hardware preflight found. Defaults to none — which is what a
   * context built without one means: nothing was checked, and nothing is
   * claimed to be wrong.
   */
  hardwareFindings?: HardwareFinding[];
  /** Seam for tests; production always gets the real coordinator built here. */
  pluginSyncs?: PluginSyncCoordinator;
  /** Seam for tests; production always gets the real repo built here. */
  accounts?: AccountRepo;
}

/**
 * Build the context every handler runs against, and register this node.
 *
 * `ensureLocalNode` runs HERE rather than at first request, so that a daemon
 * which has come up at all has a `node` row — which is what makes
 * `GET /nodes` truthful and `job.node_id` meaningful.
 */
export const createApiContext = (input: CreateApiContextInput): ApiContext => {
  const nowMs = input.nowMs ?? (() => Date.now());
  ensureLocalNode({ db: input.db, settings: input.settings, nowMs });
  return {
    db: input.db,
    settings: input.settings,
    bus: input.bus,
    supervisor: input.supervisor,
    scans: input.scans,
    accounts: input.accounts ?? createAccountRepo(input.db),
    pluginSyncs:
      input.pluginSyncs ??
      createPluginSyncCoordinator({
        db: input.db,
        bus: input.bus,
        dataDir: input.dataDir,
        nowMs,
      }),
    dataDir: input.dataDir,
    nowMs,
    version: input.version,
    schemaVersion: SCHEMA_VERSION,
    checkBinary: input.checkBinary,
    envApplications: input.envApplications ?? [],
    hardwareFindings: input.hardwareFindings ?? [],
  };
};

/**
 * The daemon's HTTP server, unstarted.
 *
 * Binding is the CALLER's step, against `settings.getDaemon()`'s `bind`
 * (default `127.0.0.1`) and `port`. The default matters: binding `0.0.0.0`
 * would expose an API whose only authentication is a shared key to the whole
 * local network on first run, before the operator has done anything at all.
 *
 * The live event stream shares this server rather than getting one of its
 * own: `attachWebSocket` (`api/ws.ts`) mounts `/api/v1/events` on the same
 * port, so there is one thing to expose and one thing to reverse-proxy.
 */
export const createApiServer = (ctx: ApiContext, options?: CreateApiHandlerOptions): Server =>
  createServer(createApiHandler(ctx, options));
