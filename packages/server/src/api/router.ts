import type { Db } from '../db/connection.js';
import type { SettingsRepo } from '../db/settings-repo.js';
import type { EventBus } from '../daemon/events.js';
import type { ScanCoordinator } from '../daemon/scan-coordinator.js';
import type { Supervisor } from '../daemon/supervisor.js';
import type { EnvApplication } from '../config/env-settings.js';
import type { HardwareFinding } from '../daemon/hardware-preflight.js';

/**
 * Everything a route handler is allowed to reach.
 *
 * Handed in rather than imported, so that every endpoint a UI will ever call
 * is reachable from a test with a fake supervisor and an in-memory database
 * — and, more importantly, so there is exactly one set of capabilities. The
 * spec's rule that "the UI is purely a client of this API — no privileged
 * path" only holds if no handler can reach further than this.
 */
export interface ApiContext {
  db: Db;
  settings: SettingsRepo;
  bus: EventBus;
  supervisor: Supervisor;
  scans: ScanCoordinator;
  nowMs: () => number;
  version: string;
  schemaVersion: number;
  /** What each seed-once environment variable did on this start. */
  envApplications: EnvApplication[];
  /**
   * Declared hardware whose encoder this node could not be shown to have.
   * Empty when every declaration checked out — and empty is what a caller
   * should expect, because a finding here means jobs routed to that hardware
   * will fail.
   */
  hardwareFindings: HardwareFinding[];
  /**
   * Does spawning this binary with `-version` work? A SEAM, defaulting to a
   * real spawn: `GET /system/version` reports it, and a test must not depend
   * on what is installed on the machine running it.
   */
  checkBinary?: (path: string) => Promise<boolean>;
}

export interface RouteInput {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  ctx: ApiContext;
}

export type RouteHandler = (input: RouteInput) => Promise<unknown> | unknown;

/**
 * A failure with a status code and a message written FOR THE CALLER.
 *
 * An `ApiError`'s message is returned to the client verbatim, because it was
 * composed to be read by one. Every other thrown value is flattened to a
 * generic 500 with no message and no stack: an internal error's text names
 * database paths, sql, and filesystem layout, and a client is not the right
 * audience for any of it.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A handler's return value when the status is part of the answer — `201` for
 * something created, `202` for work accepted but not finished, `204` for a
 * deletion with nothing left to say. A bare return value is `200`.
 */
export class ApiResponse<T = unknown> {
  readonly status: number;
  readonly body: T;

  constructor(status: number, body: T) {
    this.status = status;
    this.body = body;
  }
}

export const created = <T>(body: T): ApiResponse<T> => new ApiResponse(201, body);
export const accepted = <T>(body: T): ApiResponse<T> => new ApiResponse(202, body);
export const noContent = (): ApiResponse<null> => new ApiResponse(204, null);

export interface Route {
  method: string;
  /** Path under {@link API_PREFIX}, with `:name` segments becoming params. */
  path: string;
  handler: RouteHandler;
  /**
   * Reachable with no API key. Exactly one route sets it — `GET
   * /system/health` — so a container health check needs no secret, and
   * nothing else is readable without one.
   */
  anonymous?: boolean;
}

/**
 * Versioned from the first release. A client written against v1 must keep
 * working when v2 exists beside it; unversioned endpoints make that a
 * negotiation instead of a fact.
 */
export const API_PREFIX = '/api/v1';

export type RouteMatch =
  | { kind: 'match'; route: Route; params: Record<string, string> }
  | { kind: 'not-found' }
  | { kind: 'method-not-allowed'; allow: string[] };

interface CompiledRoute {
  route: Route;
  segments: string[];
  /** How many segments are literal — the specificity score; see `match`. */
  literals: number;
}

const compile = (route: Route): CompiledRoute => {
  const segments = route.path.split('/').filter((segment) => segment !== '');
  return {
    route,
    segments,
    literals: segments.filter((segment) => !segment.startsWith(':')).length,
  };
};

export interface Router {
  match(method: string, pathname: string): RouteMatch;
  routes(): Route[];
}

/**
 * Match a request to a route, twenty lines of table lookup rather than a
 * framework.
 *
 * SPECIFICITY, NOT DECLARATION ORDER, decides between two patterns that both
 * match: `/plugins/sources` beats `/plugins/:id` because it has more literal
 * segments. Order-dependent routing is a bug that appears only when someone
 * later reorders a list for readability, and this project has been bitten by
 * order-dependent behaviour more than once.
 *
 * A path that matches a pattern but not its method is a 405 WITH AN `Allow`
 * HEADER, never a 404: "you asked for the wrong verb" and "this endpoint
 * does not exist" send a client author to two completely different places.
 */
export const createRouter = (routes: Route[]): Router => {
  const compiled = routes.map(compile);

  return {
    routes: () => routes,

    match(method, pathname) {
      if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
        return { kind: 'not-found' };
      }
      const segments = pathname
        .slice(API_PREFIX.length)
        .split('/')
        .filter((segment) => segment !== '')
        .map((segment) => decodeURIComponent(segment));

      const candidates = compiled.filter(
        (entry) =>
          entry.segments.length === segments.length &&
          entry.segments.every(
            (pattern, index) => pattern.startsWith(':') || pattern === segments[index],
          ),
      );
      if (candidates.length === 0) return { kind: 'not-found' };

      const best = Math.max(...candidates.map((entry) => entry.literals));
      const group = candidates.filter((entry) => entry.literals === best);

      const chosen = group.find((entry) => entry.route.method === method);
      if (chosen === undefined) {
        return {
          kind: 'method-not-allowed',
          allow: [...new Set(group.map((entry) => entry.route.method))].sort(),
        };
      }

      const params: Record<string, string> = {};
      chosen.segments.forEach((pattern, index) => {
        if (pattern.startsWith(':')) params[pattern.slice(1)] = segments[index]!;
      });
      return { kind: 'match', route: chosen.route, params };
    },
  };
};

/** A route that exists, is documented, and is not built yet — see `server.ts`. */
export const notImplemented = (message: string): RouteHandler => {
  return () => {
    throw new ApiError(501, 'not-implemented', message);
  };
};

/** Reads a required string field off a JSON body, or fails with a diagnosable 400. */
export const requireString = (body: unknown, field: string): string => {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(
      400,
      'invalid-body',
      `"${field}" is required and must be a non-empty string, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
};

export const optionalBoolean = (body: unknown, field: string): boolean | undefined => {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ApiError(
      400,
      'invalid-body',
      `"${field}" must be true or false, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
};

export const optionalNumber = (body: unknown, field: string): number | undefined => {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(
      400,
      'invalid-body',
      `"${field}" must be a number, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
};

export const optionalStringArray = (body: unknown, field: string): string[] | undefined => {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ApiError(
      400,
      'invalid-body',
      `"${field}" must be an array of strings, got ${JSON.stringify(value)}.`,
    );
  }
  return value as string[];
};

/** The largest page any listing will return, and the default when none is asked for. */
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;

export interface Paging {
  limit: number;
  offset: number;
}

/**
 * `limit`/`offset` from the query string, bounded.
 *
 * An unbounded listing endpoint over a 100,000-row table is a defect, not a
 * convenience: it serialises hundreds of megabytes, holds the event loop
 * while sqlite reads synchronously, and times out whatever asked for it. A
 * limit above the cap is REJECTED rather than silently clamped — a client
 * that asked for 100,000 rows and got 500 without being told would page
 * incorrectly and lose rows.
 */
export const parsePaging = (query: URLSearchParams): Paging => {
  const limitRaw = query.get('limit');
  const offsetRaw = query.get('offset');

  const limit = limitRaw === null ? DEFAULT_PAGE_SIZE : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ApiError(
      400,
      'invalid-query',
      `"limit" must be a whole number between 1 and ${MAX_PAGE_SIZE}, got ${JSON.stringify(
        limitRaw,
      )}. It is capped because a listing that returns a whole library holds the server's single ` +
        `writer thread while it serialises, and times out the client that asked for it.`,
    );
  }

  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError(
      400,
      'invalid-query',
      `"offset" must be a whole number of 0 or more, got ${JSON.stringify(offsetRaw)}.`,
    );
  }

  return { limit, offset };
};
