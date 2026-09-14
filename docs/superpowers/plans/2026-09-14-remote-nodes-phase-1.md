# Remote Nodes (Phase 1: Direct access) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a second machine that mounts the same library enroll as a node, take jobs over one outbound WebSocket, survive disconnects mid-transcode, and never install over a file that has been handed to another worker.

**Architecture:** A `trawlarr node` process dials the daemon, and for each job forks the unchanged `worker/agent.ts` through the unchanged `createAgentHandle`, relaying agent messages inside a `{type:'agent', jobId, message}` envelope. On the daemon a `RemoteAgentHandle` implements `AgentHandle` over that socket, so the supervisor's `settleJob` stays the only place outcomes are written. Remote claims hold a lease on the job row; any library-writing step asks the daemon for a commit, which is granted only while the lease is live.

**Tech Stack:** Node 22, TypeScript (strict, project references), `ws` 8 (already a dependency of `@trawlarr/server`), `better-sqlite3`, `argon2` (already used by `api/password.ts`), vitest, React + Vite for the UI.

**Spec:** `docs/superpowers/specs/2026-09-13-remote-nodes-design.md` (read it first; this plan argues from it). Background: `docs/superpowers/specs/2026-08-10-trawlarr-design.md` §3.1, §4.3, §4.6, §4.8.

## Global Constraints

- `@trawlarr/core` performs no I/O and reads no clock; time enters as `nowMs`. Pure lease and path-map logic goes there.
- Everything on the wire must survive `JSON.parse(JSON.stringify(x))` unchanged. No `Date`, `Buffer`, `Map`, or `undefined` in a position that matters.
- Parsers for anything arriving over IPC or the node socket are strict: unrecognised input returns `null` and is dropped, never duck-typed.
- `PROTOCOL_VERSION` becomes `2`.
- Default lease grace: **1 hour** (`3_600_000` ms), stored as setting `nodes.leaseGraceMs`, minimum 5 minutes.
- Node socket path: `/api/v1/nodes/connect`. Ping every 15 s; offline after 45 s without a pong.
- Enrollment token lifetime: **24 h**. Tokens and node secrets are stored only as argon2 hashes (`hashPassword`/`verifyPassword` from `packages/server/src/api/password.ts`).
- The local node's id stays `'local'` (`LOCAL_NODE_ID` in `api/routes/nodes.ts`).
- Nothing under `packages/server/src/node/` or `packages/server/src/worker/agent.ts` may import anything under `packages/server/src/db/`.
- Migrations are forward-only; the next number is `012`.
- The stall reaper's 24 h floor (`DEFAULT_STALE_AFTER_MS`) is not lowered for any job.
- UI copy is terse: short labels, no explanatory paragraphs. The words `mapped`/`unmapped` never appear in UI or docs; they appear only in `configVars.config.nodeType`.
- Commit messages: `type(scope): lowercase sentence stating what changed and why`, ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Tests: run the touched package's tests, not the whole repo (`pnpm test -- packages/server/src/...`). Always run `pnpm typecheck` and `pnpm lint` before committing.
- Real-ffmpeg suites gate on `test-support/tool-availability.ts`; only `ENOENT` skips.
- Comments explain *why*, citing the failure a guard prevents, matching the surrounding density.

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `packages/core/src/path-map.ts` | Pure longest-prefix path translation between server and node views |
| `packages/core/src/lease.ts` | Pure lease state machine: disconnect, reconnect, expiry, commit decision |
| `packages/server/src/db/migrations/012_remote_nodes.sql` | Node enrollment/config columns; job lease + payload columns |
| `packages/server/src/db/node-repo.ts` | All reads/writes of the `node` table |
| `packages/server/src/nodes/node-frames.ts` | `NodeFrame`/`ServerFrame` types and strict parsers |
| `packages/server/src/nodes/map-payload.ts` | Apply a path map to a `JobPayload` (to node) and to a `JobReport` (back to server) |
| `packages/server/src/nodes/bundles.ts` | Build/cache source-tree manifests; resolve a bundle file safely |
| `packages/server/src/nodes/node-http.ts` | `POST /nodes/enroll` and bundle endpoints (node-secret auth, streamed files) |
| `packages/server/src/nodes/remote-agent.ts` | `createRemoteAgentHandle`: `AgentHandle` over a node connection |
| `packages/server/src/nodes/hub.ts` | Accept node sockets, handshake, registry, leases, commit decisions, re-attach, lease sweep |
| `packages/server/src/node/node-state.ts` | Node's `node.json` (server URL, node id, secret) read/write |
| `packages/server/src/node/journal.ts` | Per-job on-disk journal on the node |
| `packages/server/src/node/bundle-cache.ts` | Fetch, verify and LRU-prune bundles on the node |
| `packages/server/src/node/node-host.ts` | The node runtime: connect loop, hello, run jobs via `createAgentHandle`, relay |
| `packages/server/test/remote-node-end-to-end.test.ts` | Real daemon + real node process over loopback |
| `packages/web/src/screens/config/Nodes.tsx` | Nodes tab |
| `packages/web/src/screens/config/nodes-model.ts` | Pure view-model for the Nodes tab (tested) |
| `docker/compose.node.yml` | Example node compose file (CPU and NVIDIA services) |

**Modify:**

| File | Change |
| --- | --- |
| `packages/core/src/index.ts` | Export `path-map` and `lease` |
| `packages/server/src/worker/protocol.ts` | `commit-request`/`commit-result`; `failed.superseded`; version 2 |
| `packages/server/src/worker/agent.ts` | Commit gate over IPC |
| `packages/server/src/worker/agent-handle.ts` | `commits` dep; answer `commit-request`; `AgentFailure.superseded`; optional `settled()` |
| `packages/server/src/worker/run-payload.ts` | `commitGate` port, awaited before Replace and before unvouchable plugins; `Superseded` error |
| `packages/server/src/worker/job-payload.ts` | `pluginBundles` field |
| `packages/server/src/db/job-repo.ts` | `nodeId` on start; lease/payload columns and methods |
| `packages/server/src/db/settings-repo.ts` | `getNodes()` → `{ leaseGraceMs }` |
| `packages/server/src/daemon/supervisor.ts` | Per-node reconcile; `adopt()`; slots carry `nodeId`; `settled()` call |
| `packages/server/src/worker/reap-stalled.ts` | Pid fast path only for `nodeId === 'local'`; skip leased remote jobs |
| `packages/server/src/daemon/daemon.ts` | Build hub; attach socket; lease sweep interval; adopt orphans at start |
| `packages/server/src/api/server.ts` | Consult `node-http` before the router |
| `packages/server/src/api/router.ts` | `ApiContext.nodes: NodeHub` |
| `packages/server/src/api/routes/nodes.ts` | CRUD, enroll token, revoke, path map, schedule, pause |
| `packages/server/src/cli.ts` | `trawlarr node` subcommand |
| `docker/entrypoint.sh` | `TRAWLARR_MODE=node` |
| `packages/web/src/screens/config/Config.tsx`, `packages/web/src/shell/route.ts` | Nodes tab |
| `README.md` | "Remote nodes" section |

---

### Task 1: Pure path mapping and lease logic in core

**Files:**
- Create: `packages/core/src/path-map.ts`, `packages/core/src/path-map.test.ts`, `packages/core/src/lease.ts`, `packages/core/src/lease.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `interface PathMapping { serverPath: string; nodePath: string }`
  - `mapPath(map: readonly PathMapping[], path: string, direction: 'toNode' | 'toServer'): string | null`
  - `validatePathMap(map: unknown): PathMapping[]` (throws `PathMapError`)
  - `type LeaseState = 'connected' | 'grace' | 'committing' | 'expired'`
  - `interface Lease { state: LeaseState; expiresAtMs: number | null }`
  - `leaseOnClaim(): Lease`, `leaseOnDisconnect(lease, nowMs, graceMs): Lease`, `leaseOnDaemonStart(lease, nowMs, graceMs): Lease`, `leaseOnReconnect(lease, nowMs): Lease`, `leaseIsExpired(lease, nowMs): boolean`, `leaseAfterStep(lease): Lease`
  - `decideCommit(input: { lease: Lease; nowMs: number; stillClaimed: boolean; kind: 'replace' | 'plugin' }): { granted: true; lease: Lease } | { granted: false; reason: string }`

- [ ] **Step 1: Write the failing path-map tests**

```ts
// packages/core/src/path-map.test.ts
import { describe, expect, it } from 'vitest';
import { PathMapError, mapPath, validatePathMap } from './path-map.js';

const map = [
  { serverPath: '/media', nodePath: '/mnt/nas' },
  { serverPath: '/media/movies', nodePath: '/mnt/movies' },
];

describe('mapPath', () => {
  it('uses the longest matching prefix', () => {
    expect(mapPath(map, '/media/movies/a.mkv', 'toNode')).toBe('/mnt/movies/a.mkv');
    expect(mapPath(map, '/media/shows/b.mkv', 'toNode')).toBe('/mnt/nas/shows/b.mkv');
  });

  it('matches whole path segments only', () => {
    // "/media/movies2" must not be read as inside "/media/movies".
    expect(mapPath(map, '/media/movies2/a.mkv', 'toNode')).toBe('/mnt/nas/movies2/a.mkv');
    expect(mapPath([{ serverPath: '/media', nodePath: '/x' }], '/mediax/a', 'toNode')).toBeNull();
  });

  it('maps the root itself', () => {
    expect(mapPath(map, '/media/movies', 'toNode')).toBe('/mnt/movies');
  });

  it('reverses', () => {
    expect(mapPath(map, '/mnt/movies/a.mkv', 'toServer')).toBe('/media/movies/a.mkv');
  });

  it('returns null for an unmapped path instead of passing it through', () => {
    // Passing it through would run a job against whatever happens to live at
    // the server's path on the node — possibly a different file entirely.
    expect(mapPath(map, '/srv/other.mkv', 'toNode')).toBeNull();
  });

  it('an empty map is the identity for the local node only when asked: still null', () => {
    expect(mapPath([], '/media/a.mkv', 'toNode')).toBeNull();
  });
});

describe('validatePathMap', () => {
  it('accepts absolute, normalised paths and strips trailing slashes', () => {
    expect(validatePathMap([{ serverPath: '/media/', nodePath: '/mnt/nas/' }])).toEqual([
      { serverPath: '/media', nodePath: '/mnt/nas' },
    ]);
  });

  it('rejects relative paths, dot segments, and duplicate server paths', () => {
    expect(() => validatePathMap([{ serverPath: 'media', nodePath: '/x' }])).toThrow(PathMapError);
    expect(() => validatePathMap([{ serverPath: '/media/../etc', nodePath: '/x' }])).toThrow(PathMapError);
    expect(() =>
      validatePathMap([
        { serverPath: '/media', nodePath: '/x' },
        { serverPath: '/media', nodePath: '/y' },
      ]),
    ).toThrow(PathMapError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- packages/core/src/path-map.test.ts`
Expected: FAIL, cannot resolve `./path-map.js`.

- [ ] **Step 3: Implement `path-map.ts`**

```ts
// packages/core/src/path-map.ts
/**
 * Server path <-> node path, for a node that mounts the library somewhere
 * else (spec: remote nodes, "Path mapping").
 *
 * Pure string work — core does no I/O, so whether the mapped path EXISTS is
 * the node's probe, not this. An unmapped path is `null`, never passed
 * through: a node that ran against the server's literal path would be
 * operating on whatever that path means on ITS disk.
 */
export interface PathMapping {
  serverPath: string;
  nodePath: string;
}

export class PathMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathMapError';
  }
}

const trimTrailing = (path: string): string =>
  path.length > 1 && path.endsWith('/') ? trimTrailing(path.slice(0, -1)) : path;

const checkAbsolute = (label: string, path: unknown): string => {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new PathMapError(`${label} must be an absolute path, got ${JSON.stringify(path)}.`);
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new PathMapError(`${label} must not contain "." or ".." segments: "${path}".`);
  }
  return trimTrailing(path);
};

export const validatePathMap = (map: unknown): PathMapping[] => {
  if (!Array.isArray(map)) throw new PathMapError('A path map must be a list.');
  const seen = new Set<string>();
  return map.map((entry: unknown, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const serverPath = checkAbsolute(`Entry ${String(index + 1)}: server path`, record['serverPath']);
    const nodePath = checkAbsolute(`Entry ${String(index + 1)}: node path`, record['nodePath']);
    if (seen.has(serverPath)) {
      throw new PathMapError(`Server path "${serverPath}" is mapped more than once.`);
    }
    seen.add(serverPath);
    return { serverPath, nodePath };
  });
};

const within = (root: string, path: string): boolean =>
  root === '/' || path === root || path.startsWith(`${root}/`);

export const mapPath = (
  map: readonly PathMapping[],
  path: string,
  direction: 'toNode' | 'toServer',
): string | null => {
  let best: { from: string; to: string } | null = null;
  for (const entry of map) {
    const from = direction === 'toNode' ? entry.serverPath : entry.nodePath;
    const to = direction === 'toNode' ? entry.nodePath : entry.serverPath;
    if (within(from, path) && (best === null || from.length > best.from.length)) {
      best = { from, to };
    }
  }
  if (best === null) return null;
  const rest = best.from === '/' ? path.slice(1) : path.slice(best.from.length + 1);
  if (path === best.from) return best.to;
  return best.to === '/' ? `/${rest}` : `${best.to}/${rest}`;
};
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- packages/core/src/path-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing lease tests**

```ts
// packages/core/src/lease.test.ts
import { describe, expect, it } from 'vitest';
import {
  decideCommit,
  leaseAfterStep,
  leaseIsExpired,
  leaseOnClaim,
  leaseOnDaemonStart,
  leaseOnDisconnect,
  leaseOnReconnect,
} from './lease.js';

const HOUR = 3_600_000;

describe('lease', () => {
  it('starts connected with no expiry', () => {
    expect(leaseOnClaim()).toEqual({ state: 'connected', expiresAtMs: null });
  });

  it('a disconnect starts the grace clock', () => {
    expect(leaseOnDisconnect(leaseOnClaim(), 1000, HOUR)).toEqual({
      state: 'grace',
      expiresAtMs: 1000 + HOUR,
    });
  });

  it('a disconnect while committing does NOT start a clock', () => {
    // The node may be mid-rename. Expiring now would release a file whose
    // replacement is landing; only the 24 h reaper floor may act on it.
    const committing = { state: 'committing' as const, expiresAtMs: null };
    expect(leaseOnDisconnect(committing, 1000, HOUR)).toEqual(committing);
  });

  it('expires only in grace and only once the deadline has passed', () => {
    const grace = leaseOnDisconnect(leaseOnClaim(), 0, HOUR);
    expect(leaseIsExpired(grace, HOUR - 1)).toBe(false);
    expect(leaseIsExpired(grace, HOUR)).toBe(true);
    expect(leaseIsExpired(leaseOnClaim(), 10 * HOUR)).toBe(false);
    expect(leaseIsExpired({ state: 'committing', expiresAtMs: null }, 10 * HOUR)).toBe(false);
  });

  it('reconnecting inside grace restores connected; after expiry it stays expired', () => {
    const grace = leaseOnDisconnect(leaseOnClaim(), 0, HOUR);
    expect(leaseOnReconnect(grace, HOUR - 1)).toEqual({ state: 'connected', expiresAtMs: null });
    expect(leaseOnReconnect(grace, HOUR).state).toBe('expired');
    expect(leaseOnReconnect({ state: 'expired', expiresAtMs: 5 }, 0).state).toBe('expired');
  });

  it('daemon start gives every non-committing lease a fresh grace window from startup', () => {
    expect(leaseOnDaemonStart(leaseOnClaim(), 50, HOUR)).toEqual({
      state: 'grace',
      expiresAtMs: 50 + HOUR,
    });
    const oldGrace = { state: 'grace' as const, expiresAtMs: 1 };
    expect(leaseOnDaemonStart(oldGrace, 50, HOUR).expiresAtMs).toBe(50 + HOUR);
  });

  it('leaseAfterStep returns committing to connected and leaves others alone', () => {
    expect(leaseAfterStep({ state: 'committing', expiresAtMs: null }).state).toBe('connected');
    expect(leaseAfterStep({ state: 'grace', expiresAtMs: 9 }).state).toBe('grace');
  });
});

describe('decideCommit', () => {
  const connected = leaseOnClaim();

  it('grants a replace on a connected, still-claimed job and moves to committing', () => {
    expect(decideCommit({ lease: connected, nowMs: 0, stillClaimed: true, kind: 'replace' })).toEqual({
      granted: true,
      lease: { state: 'committing', expiresAtMs: null },
    });
  });

  it('grants a plugin commit without entering committing', () => {
    expect(decideCommit({ lease: connected, nowMs: 0, stillClaimed: true, kind: 'plugin' })).toEqual({
      granted: true,
      lease: connected,
    });
  });

  it('refuses when the file is no longer claimed by this job', () => {
    const decision = decideCommit({ lease: connected, nowMs: 0, stillClaimed: false, kind: 'replace' });
    expect(decision.granted).toBe(false);
  });

  it('refuses in grace and expired — a commit needs a live connection', () => {
    for (const lease of [
      { state: 'grace' as const, expiresAtMs: 100 },
      { state: 'expired' as const, expiresAtMs: 100 },
    ]) {
      expect(decideCommit({ lease, nowMs: 0, stillClaimed: true, kind: 'replace' }).granted).toBe(false);
    }
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm test -- packages/core/src/lease.test.ts`
Expected: FAIL, cannot resolve `./lease.js`.

- [ ] **Step 7: Implement `lease.ts`**

```ts
// packages/core/src/lease.ts
/**
 * A remote claim's lease (spec: remote nodes, "Leases").
 *
 * The whole point is one guarantee: a file is never written by two workers.
 * A remote node can go quiet for reasons that say nothing about its encode
 * (a Wi-Fi blip, the daemon restarting), so silence alone must not release
 * the file for ever — but it must release it eventually, and once released,
 * the original node must be unable to install. Expiry releases; `decideCommit`
 * is what makes the original node unable to install afterwards.
 */
export type LeaseState = 'connected' | 'grace' | 'committing' | 'expired';

export interface Lease {
  state: LeaseState;
  expiresAtMs: number | null;
}

export const leaseOnClaim = (): Lease => ({ state: 'connected', expiresAtMs: null });

export const leaseOnDisconnect = (lease: Lease, nowMs: number, graceMs: number): Lease =>
  lease.state === 'connected' ? { state: 'grace', expiresAtMs: nowMs + graceMs } : lease;

/**
 * A daemon that was down has no idea how long its nodes have been
 * disconnected, and a lease that ran out while nobody was counting must not
 * expire the instant the daemon returns — that would release every remote
 * encode on every restart. So the clock restarts from startup.
 */
export const leaseOnDaemonStart = (lease: Lease, nowMs: number, graceMs: number): Lease =>
  lease.state === 'connected' || lease.state === 'grace'
    ? { state: 'grace', expiresAtMs: nowMs + graceMs }
    : lease;

export const leaseIsExpired = (lease: Lease, nowMs: number): boolean =>
  lease.state === 'grace' && lease.expiresAtMs !== null && nowMs >= lease.expiresAtMs;

export const leaseOnReconnect = (lease: Lease, nowMs: number): Lease => {
  if (lease.state === 'expired' || leaseIsExpired(lease, nowMs)) {
    return { state: 'expired', expiresAtMs: lease.expiresAtMs };
  }
  if (lease.state === 'grace') return { state: 'connected', expiresAtMs: null };
  return lease;
};

export const leaseAfterStep = (lease: Lease): Lease =>
  lease.state === 'committing' ? { state: 'connected', expiresAtMs: null } : lease;

export const decideCommit = (input: {
  lease: Lease;
  nowMs: number;
  stillClaimed: boolean;
  kind: 'replace' | 'plugin';
}): { granted: true; lease: Lease } | { granted: false; reason: string } => {
  if (!input.stillClaimed) {
    return {
      granted: false,
      reason: 'This file is no longer claimed by this job; another worker may own it.',
    };
  }
  const { lease } = input;
  if (lease.state !== 'connected' && lease.state !== 'committing') {
    return {
      granted: false,
      reason: `The job's lease is ${lease.state}; a commit needs a live connection.`,
    };
  }
  if (input.kind === 'replace') return { granted: true, lease: { state: 'committing', expiresAtMs: null } };
  return { granted: true, lease };
};
```

- [ ] **Step 8: Export from core, run tests, typecheck, lint**

Add to `packages/core/src/index.ts` (match the file's existing `export * from` style):

```ts
export * from './path-map.js';
export * from './lease.js';
```

Run: `pnpm test -- packages/core/src/path-map.test.ts packages/core/src/lease.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS, no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/path-map.ts packages/core/src/path-map.test.ts packages/core/src/lease.ts packages/core/src/lease.test.ts packages/core/src/index.ts
git commit -m "feat(core): model remote leases and path maps purely, so a released file can never be committed by its old node

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Migration, node repo, job lease columns, lease-grace setting

**Files:**
- Create: `packages/server/src/db/migrations/012_remote_nodes.sql`, `packages/server/src/db/node-repo.ts`, `packages/server/src/db/node-repo.test.ts`
- Modify: `packages/server/src/db/job-repo.ts` (+ its test), `packages/server/src/db/settings-repo.ts` (+ its test), `packages/server/src/api/routes/nodes.ts` (`ensureLocalNode` keeps working with the new columns)

**Interfaces:**
- Consumes: `Lease`, `LeaseState`, `PathMapping`, `validatePathMap` (Task 1); `ScheduleConfig`, `DEFAULT_SCHEDULE`, `validateSchedule`, `HardwareType` from `@trawlarr/core`; `hashPassword`/`verifyPassword` from `api/password.ts`
- Produces:

```ts
// node-repo.ts
export interface NodeRecord {
  id: string;
  name: string;
  accessMode: 'direct' | 'transfer';
  pathMap: PathMapping[];
  hardwareTypes: HardwareType[];
  hardwareCaps: Partial<Record<HardwareType, number>>;
  tags: string;
  lastSeenAt: number | null;
  schedule: ScheduleConfig;          // worker_config_json; DEFAULT_SCHEDULE when unset
  paused: boolean;
  buildVersion: string | null;
  ffmpeg: { ffmpegPath: string; ffprobePath: string } | null;
  libraries: NodeLibraryProbe[];     // last probe results
  revokedAt: number | null;
  enrolled: boolean;                 // secret_hash IS NOT NULL
  enrollExpiresAt: number | null;
}
export interface NodeLibraryProbe { libraryId: string; reachable: boolean; detail: string }
export interface NodeRepo {
  list(): NodeRecord[];
  getById(id: string): NodeRecord | null;
  create(input: { name: string; nowMs: number }): { node: NodeRecord; enrollToken: string };
  regenerateEnrollToken(input: { id: string; nowMs: number }): { enrollToken: string; expiresAt: number };
  /** Consumes the token. Returns null for unknown/expired/used/revoked. */
  enroll(input: { token: string; nowMs: number }): Promise<{ nodeId: string; secret: string } | null>;
  /** Returns the node id the secret belongs to, or null. Never for a revoked node. */
  authenticate(input: { nodeId: string; secret: string }): Promise<boolean>;
  update(id: string, patch: { name?: string; pathMap?: unknown; schedule?: ScheduleConfig; paused?: boolean; tags?: string }): NodeRecord;
  recordHello(id: string, hello: { buildVersion: string; hardwareTypes: HardwareType[]; hardwareCaps: Partial<Record<HardwareType, number>>; ffmpegPath: string; ffprobePath: string; nowMs: number }): void;
  recordLibraries(id: string, libraries: NodeLibraryProbe[]): void;
  touch(id: string, nowMs: number): void;
  revoke(id: string, nowMs: number): void;
  remove(id: string): void;   // throws NodeRepoError if the node has an unended job
}
export class NodeRepoError extends Error {}
export const createNodeRepo: (db: Db) => NodeRepo;

// job-repo.ts additions
export interface JobLeaseRow { jobId: string; fileId: string; nodeId: string; lease: Lease; payloadJson: string; pathMapJson: string }
interface JobRepo {
  // start() gains: nodeId?: string | null  (existing optional field now actually written)
  setRemote(input: { jobId: string; nodeId: string; lease: Lease; payloadJson: string; pathMapJson: string }): void;
  setLease(input: { jobId: string; lease: Lease }): void;
  listLeased(): JobLeaseRow[];   // ended_at IS NULL AND lease_state IS NOT NULL
  appendOutcome(input: { jobId: string; text: string }): void;
}
// JobRow gains: leaseState: LeaseState | null; leaseExpiresAt: number | null

// settings-repo.ts addition
getNodes(): { leaseGraceMs: number };
setNodes(value: { leaseGraceMs: number }): void;   // SettingValidationError below 300_000
```

**Node ids and secrets.** A node id is `node-` + 12 lowercase base32 chars from `randomBytes`. An enrollment token is `tnode_enroll_` + 32 base64url bytes. The node secret is `tnode_` + 32 base64url bytes. `enroll()` looks up candidates whose `enroll_expires_at > nowMs AND secret_hash IS NULL AND revoked_at IS NULL`, then `verifyPassword` against each. There are few pending nodes, so a scan is fine. On a match it sets `secret_hash`, clears `enroll_token_hash`/`enroll_expires_at`, and returns. `authenticate` takes the node id (sent by the node in the `X-Trawlarr-Node` header), so verification is one argon2 check, never a scan.

- [ ] **Step 1: Write the migration**

```sql
-- packages/server/src/db/migrations/012_remote_nodes.sql
-- REMOTE NODES (spec 2026-09-13-remote-nodes-design.md).
--
-- A node row existed from the first migration for the local node only. A
-- remote node adds: how it proves who it is (secret_hash, stored as argon2,
-- never the secret), how it first joined (a single-use enrollment token, also
-- hashed), and what the server tells it to do (worker_config_json = a
-- ScheduleConfig, the same model the local node's settings use).
ALTER TABLE node ADD COLUMN secret_hash TEXT;
ALTER TABLE node ADD COLUMN enroll_token_hash TEXT;
ALTER TABLE node ADD COLUMN enroll_expires_at INTEGER;
ALTER TABLE node ADD COLUMN revoked_at INTEGER;
ALTER TABLE node ADD COLUMN worker_config_json TEXT;
ALTER TABLE node ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE node ADD COLUMN build_version TEXT;
ALTER TABLE node ADD COLUMN ffmpeg_json TEXT;
ALTER TABLE node ADD COLUMN hardware_caps_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE node ADD COLUMN libraries_json TEXT NOT NULL DEFAULT '[]';

-- A remote job's LEASE. NULL on every local job: a local worker's liveness is
-- a pid in this host's process table, which a remote one does not have.
ALTER TABLE job ADD COLUMN lease_state TEXT;
ALTER TABLE job ADD COLUMN lease_expires_at INTEGER;
-- The payload exactly as built on the SERVER (server paths), and the path map
-- it was sent through. A report that arrives after a daemon restart has no
-- in-memory payload to be applied against, and the node's map may have been
-- edited since; both are needed to fold that report back in faithfully.
ALTER TABLE job ADD COLUMN payload_json TEXT;
ALTER TABLE job ADD COLUMN path_map_json TEXT;

CREATE INDEX job_leased_idx ON job (lease_state) WHERE ended_at IS NULL AND lease_state IS NOT NULL;
```

- [ ] **Step 2: Write failing node-repo tests**

Use the in-memory database helper the existing repo tests use (`packages/server/src/db/job-repo.test.ts` shows the pattern: open a migrated in-memory `Db`). Tests to write, each one `it(...)`:

```ts
// packages/server/src/db/node-repo.test.ts (excerpt: write all of these)
it('create returns a token once and stores only its hash', async () => {
  const repo = createNodeRepo(db);
  const { node, enrollToken } = repo.create({ name: 'gpu-box', nowMs: 1000 });
  expect(enrollToken).toMatch(/^tnode_enroll_/);
  const raw = db.prepare('SELECT enroll_token_hash, secret_hash FROM node WHERE id = ?').get(node.id) as Record<string, string | null>;
  expect(raw.enroll_token_hash).not.toContain(enrollToken);
  expect(raw.secret_hash).toBeNull();
  expect(node.enrolled).toBe(false);
});

it('enroll consumes the token exactly once', async () => {
  const repo = createNodeRepo(db);
  const { enrollToken, node } = repo.create({ name: 'n', nowMs: 0 });
  const first = await repo.enroll({ token: enrollToken, nowMs: 1 });
  expect(first?.nodeId).toBe(node.id);
  expect(await repo.enroll({ token: enrollToken, nowMs: 2 })).toBeNull();
  expect(await repo.authenticate({ nodeId: node.id, secret: first!.secret })).toBe(true);
});

it('an expired token does not enroll', async () => {
  const repo = createNodeRepo(db);
  const { enrollToken } = repo.create({ name: 'n', nowMs: 0 });
  expect(await repo.enroll({ token: enrollToken, nowMs: 24 * 3_600_000 })).toBeNull();
});

it('a revoked node cannot authenticate even with the right secret', async () => {
  const repo = createNodeRepo(db);
  const { enrollToken, node } = repo.create({ name: 'n', nowMs: 0 });
  const { secret } = (await repo.enroll({ token: enrollToken, nowMs: 1 }))!;
  repo.revoke(node.id, 5);
  expect(await repo.authenticate({ nodeId: node.id, secret })).toBe(false);
});

it('update validates the path map and schedule', () => {
  const repo = createNodeRepo(db);
  const { node } = repo.create({ name: 'n', nowMs: 0 });
  expect(() => repo.update(node.id, { pathMap: [{ serverPath: 'rel', nodePath: '/x' }] })).toThrow();
  expect(repo.update(node.id, { pathMap: [{ serverPath: '/media/', nodePath: '/mnt' }] }).pathMap).toEqual([
    { serverPath: '/media', nodePath: '/mnt' },
  ]);
});

it('remove refuses a node with a running job', () => { /* insert a job row with node_id and ended_at NULL; expect NodeRepoError */ });

it('names must be unique and non-empty', () => { /* create twice with same name -> NodeRepoError */ });

it('the local node row still reads back', () => { /* call ensureLocalNode, then repo.getById('local') is non-null, enrolled false, schedule DEFAULT_SCHEDULE */ });
```

For the `remove` and uniqueness tests, write the full bodies. Insert the job row with the same SQL `job-repo.test.ts` uses for a running job, plus `node_id = node.id`.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test -- packages/server/src/db/node-repo.test.ts`
Expected: FAIL, cannot resolve `./node-repo.js`.

- [ ] **Step 4: Implement `node-repo.ts`**

Implement exactly the interface above. Notes:
- `create` checks name uniqueness in a transaction (there is no DB constraint; add the check rather than a migration so the local row named `local` keeps working). It inserts `access_mode='direct'`, `path_map_json='[]'`, `hardware_types_json='["cpu"]'`, `enroll_expires_at = nowMs + 24h`. Hashing is async while better-sqlite3 is sync, so compute the hash first (`await hashPassword(token)`), then insert. `create` therefore returns a `Promise`; update the interface to `create(...): Promise<{ node; enrollToken }>`, and likewise `regenerateEnrollToken`.
- `schedule` reads `worker_config_json` through `JSON.parse` then `validateSchedule`. Fall back to `DEFAULT_SCHEDULE` when null.
- Row-to-record mapping lives in one `toRecord(row)` function.

- [ ] **Step 5: Extend job-repo, with failing tests first**

Add tests to `packages/server/src/db/job-repo.test.ts`:
- `start({ nodeId: 'local', ... })` writes `node_id`. Requires the `node` row to exist (FK), so call `ensureLocalNode` or insert it in the test.
- `setRemote` then `listLeased()` returns the row with `lease: { state: 'connected', expiresAtMs: null }`, plus `payloadJson` and `pathMapJson` round-tripped.
- `setLease` to `grace` with an expiry persists both columns.
- `finish(...)` removes the job from `listLeased()`.
- `appendOutcome` appends `\n` + text to an existing outcome, and sets it when null.

Run: `pnpm test -- packages/server/src/db/job-repo.test.ts` (expect FAIL), implement, re-run (expect PASS).

- [ ] **Step 6: Settings, with failing test first**

In `settings-repo.test.ts`: `getNodes()` defaults to `{ leaseGraceMs: 3_600_000 }`, `setNodes({ leaseGraceMs: 299_999 })` throws `SettingValidationError`, and a valid value round-trips. Implement using the same key/JSON storage pattern as `getScan` (setting key `nodes`).

- [ ] **Step 7: Run all touched tests, typecheck, lint**

Run: `pnpm test -- packages/server/src/db && pnpm typecheck && pnpm lint`
Expected: PASS. Existing migration tests must still pass. If a test asserts the latest schema version, bump it to 12.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/db
git commit -m "feat(server): store node enrollment, secrets and job leases, so a remote claim can outlive its connection

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Protocol v2 and node frames

**Files:**
- Modify: `packages/server/src/worker/protocol.ts`, `packages/server/src/worker/protocol.test.ts`
- Create: `packages/server/src/nodes/node-frames.ts`, `packages/server/src/nodes/node-frames.test.ts`

**Interfaces:**
- Consumes: `AgentToDaemon`, `DaemonToAgent`, `parseAgentMessage`, `parseDaemonMessage`, `JobPayload`; `PathMapping`, `ScheduleConfig`, `HardwareType` from core; `NodeLibraryProbe` (Task 2)
- Produces:

```ts
// protocol.ts additions
| { type: 'commit-request'; id: number; kind: 'replace' | 'plugin'; pluginId: string }   // AgentToDaemon
| { type: 'commit-result'; id: number; granted: boolean; reason: string | null }        // DaemonToAgent
// AgentToDaemon 'failed' gains optional superseded?: boolean
export const PROTOCOL_VERSION = 2;

// node-frames.ts
export type JournalState = 'running' | 'held-report' | 'lost';
export interface HelloFrame {
  type: 'hello';
  protocolVersion: number;
  buildVersion: string;
  hardwareTypes: HardwareType[];
  hardwareCaps: Partial<Record<HardwareType, number>>;
  ffmpegPath: string;
  ffprobePath: string;
  jobs: { jobId: string; state: JournalState; logLineCount: number }[];
}
export type NodeFrame =
  | HelloFrame
  | { type: 'agent'; jobId: string; message: AgentToDaemon }
  | { type: 'libraries'; libraries: NodeLibraryProbe[] }
  | { type: 'job-state'; jobId: string; state: JournalState }
  | { type: 'log-backfill'; jobId: string; fromLine: number; lines: string[] };

export interface NodeConfigFrame {
  type: 'config';
  nodeId: string;
  schedule: ScheduleConfig;
  paused: boolean;
  pathMap: PathMapping[];
  /** Server-side roots per library, already mapped to node paths; null when unmapped. */
  libraries: { libraryId: string; name: string; nodeRoots: (string | null)[] }[];
}
export type ServerFrame =
  | { type: 'welcome'; config: NodeConfigFrame; jobs: { jobId: string; action: 'continue' | 'abandon' | 'apply-report' | 'lost'; logLinesHave: number }[] }
  | { type: 'refused'; reason: string; retryAfterMs: number }
  | NodeConfigFrame
  | { type: 'job'; jobId: string; payload: JobPayload }
  | { type: 'agent'; jobId: string; message: DaemonToAgent }
  | { type: 'abandon'; jobId: string; reason: string }
  | { type: 'ack-report'; jobId: string };
export const parseNodeFrame: (raw: string) => NodeFrame | null;   // JSON.parse inside try; null on bad JSON
export const parseServerFrame: (raw: string) => ServerFrame | null;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
```

A remote job's payload travels in its own `job` frame, not inside an `agent` envelope. The node host feeds it to its local `createAgentHandle.run()`. Inside the envelope, `DaemonToAgent` carries only `cancel`, `doc-result` and `commit-result`, and `parseServerFrame` rejects an enveloped `job`.

- [ ] **Step 1: Failing protocol tests**

Add to `protocol.test.ts`:

```ts
it('parses commit-request and rejects an unknown kind', () => {
  expect(parseAgentMessage({ type: 'commit-request', id: 1, kind: 'replace', pluginId: 'trawlarr:replaceOriginal' }))
    .toEqual({ type: 'commit-request', id: 1, kind: 'replace', pluginId: 'trawlarr:replaceOriginal' });
  expect(parseAgentMessage({ type: 'commit-request', id: 1, kind: 'delete', pluginId: 'x' })).toBeNull();
});

it('parses commit-result both ways', () => {
  expect(parseDaemonMessage({ type: 'commit-result', id: 3, granted: false, reason: 'no' }))
    .toEqual({ type: 'commit-result', id: 3, granted: false, reason: 'no' });
  expect(parseDaemonMessage({ type: 'commit-result', id: 3, granted: 'yes', reason: null })).toBeNull();
});

it('carries superseded on failed', () => {
  expect(parseAgentMessage({ type: 'failed', error: 'x', superseded: true }))
    .toEqual({ type: 'failed', error: 'x', superseded: true });
  expect(parseAgentMessage({ type: 'failed', error: 'x', superseded: 'y' })).toBeNull();
});

it('every new message survives a JSON round trip unchanged', () => {
  const messages = [
    { type: 'commit-request', id: 1, kind: 'plugin', pluginId: 'a' },
    { type: 'failed', error: 'e', superseded: true },
  ];
  for (const message of messages) expect(parseAgentMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
});
```

- [ ] **Step 2: Run, verify failure, implement protocol additions, verify pass**

Run: `pnpm test -- packages/server/src/worker/protocol.test.ts`. Expect FAIL, then implement the new `case` branches in `parseAgentMessage`/`parseDaemonMessage` following the existing style, set `PROTOCOL_VERSION = 2`, and re-run to PASS. Update the `PROTOCOL_VERSION` doc comment: it is now load-bearing, because remote nodes exist.

- [ ] **Step 3: Failing node-frame tests**

In `node-frames.test.ts`, cover:
- a valid `hello` parses; `hello` with `protocolVersion` as a string returns null; an unknown hardware type returns null;
- `agent` with an inner message that fails `parseAgentMessage` returns null (the whole frame is dropped);
- an `agent` frame whose inner message is `{type:'job'}` is rejected by `parseServerFrame`;
- `log-backfill` with a non-string line returns null;
- non-JSON text returns null; a string longer than `MAX_FRAME_BYTES` returns null without calling `JSON.parse`;
- every frame type round-trips.

- [ ] **Step 4: Implement `node-frames.ts`, run to pass**

Reuse `parseAgentMessage`/`parseDaemonMessage` for enveloped messages. Validate hardware types against `HARDWARE_TYPES` from core. For `job` frames, check `payload` is a record with a string `jobId` equal to the frame's `jobId`; deeper payload validation is the node's `runPayload`'s job, as today.

Run: `pnpm test -- packages/server/src/nodes/node-frames.test.ts packages/server/src/worker && pnpm typecheck && pnpm lint`
Expected: PASS. Existing agent tests still pass: the version bump affects nothing locally, because `agent-handle.ts` puts the constant into the child's environment.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/worker/protocol.ts packages/server/src/worker/protocol.test.ts packages/server/src/nodes
git commit -m "feat(server): define the node socket frames and the commit round trip as strict plain-json wire formats

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The commit gate on the run path (local behaviour unchanged)

**Files:**
- Modify: `packages/server/src/worker/run-payload.ts`, `packages/server/src/worker/agent.ts`, `packages/server/src/worker/agent-handle.ts`, `packages/server/src/worker/run-job.ts` (in-process path), `packages/server/src/daemon/supervisor.ts` (pass the grant-all commits port)
- Test: `packages/server/src/worker/run-payload.test.ts`, `packages/server/src/worker/agent-handle.test.ts`

**Interfaces:**
- Consumes: `commit-request`/`commit-result`, `failed.superseded` (Task 3); `classifySideEffects` from `@trawlarr/engine`
- Produces:

```ts
// run-payload.ts
export type CommitGate = (request: { kind: 'replace' | 'plugin'; pluginId: string }) => Promise<void>;
export class SupersededError extends Error { readonly reason: string }   // name 'SupersededError'
// RunPayloadPorts gains: commitGate?: CommitGate   (absent = grant immediately)

// agent-handle.ts
export type CommitPort = (request: { kind: 'replace' | 'plugin'; pluginId: string }) => Promise<{ granted: boolean; reason: string | null }>;
export const GRANT_ALL: CommitPort;
// AgentHandleDeps gains: commits?: CommitPort   (default GRANT_ALL)
// AgentFailure options/fields gain: superseded: boolean
// AgentHandle gains: settled?(): void   (called by the supervisor after the outcome is written)
```

**Where the gate applies.** In `run-payload.ts`'s `loadPlugin`, wrap `module.plugin` so it first does `await gate({kind, pluginId})`:
- when `node.pluginId === 'trawlarr:replaceOriginal'`: `kind: 'replace'`;
- for every plugin whose `classifySideEffects(loaded) === 'unknown'` (installed and path-named plugins): `kind: 'plugin'`.

Inert and engine-controlled first-party nodes other than Replace do not ask. Execute writes only into the staging work dir, and Verify and Check Size only read.

A refused gate throws `SupersededError`. It must escape `runFlow` rather than being routed to an `onFlowError` node: a flow's error handler must never run after the file has been released. Catch `SupersededError` around `runFlow` in `runPayload` and re-throw it after the `finally` blocks have removed the work dir. Check how `runFlow` catches plugin throws in `packages/engine/src/executor/run-flow.ts`. If it converts every throw into an error route, add an engine-level escape hatch: an exported `FlowAbort` base class that `runFlow` re-throws instead of routing, and make `SupersededError extends FlowAbort`. Add an engine test proving a `FlowAbort` thrown by a plugin bypasses an `onFlowError` node.

In `agent.ts`, when `runPayload` rejects with `SupersededError`, send `{ type: 'failed', error: message, superseded: true }`.

- [ ] **Step 1: Failing run-payload tests**

Reuse the fixture flow the existing `run-payload.test.ts` Replace tests build (a generated `lavfi` source, an Execute node, and a Replace node). Add:

```ts
it('asks the commit gate before Replace Original File and not before Execute', async () => {
  const asked: { kind: string; pluginId: string }[] = [];
  const report = await runPayload({
    payload,
    ports: { ...ports, commitGate: async (request) => { asked.push(request); } },
  });
  expect(asked).toEqual([{ kind: 'replace', pluginId: 'trawlarr:replaceOriginal' }]);
  expect(report.replaced).not.toBeNull();
});

it('a refused gate leaves the original byte-identical, removes staging, and bypasses onFlowError', async () => {
  const before = await readFile(payload.path);
  await expect(
    runPayload({
      payload: withOnErrorNode(payload),   // flow that routes errors to trawlarr:onError -> writeToLog
      ports: { ...ports, commitGate: async () => { throw new SupersededError('released'); } },
    }),
  ).rejects.toBeInstanceOf(SupersededError);
  expect(await readFile(payload.path)).toEqual(before);
  expect(await listStagingDirs(payload)).toEqual([]);   // helper: readdir of resolveStagingDir, filtered by workDirPrefix
  expect(stepsSeen.some((step) => step.pluginId === 'trawlarr:onError')).toBe(false);
});

it('asks with kind plugin before an installed third-party plugin', async () => { /* use the existing test plugin fixture loaded by path */ });

it('with no commitGate port, behaves exactly as before', async () => { /* existing Replace test passes unchanged; assert replaced !== null */ });
```

Write `withOnErrorNode` and `listStagingDirs` as local helpers in the test file.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- packages/server/src/worker/run-payload.test.ts`
Expected: FAIL, `SupersededError` not exported.

- [ ] **Step 3: Implement the gate in `run-payload.ts`** (plus `FlowAbort` in the engine if Step 1's investigation requires it), then re-run to PASS.

- [ ] **Step 4: Failing agent-handle tests**

In `agent-handle.test.ts`, using the existing fake child (`test/fake-child.ts` / the file's own `forkFn` doubles):
- a `commit-request` from the child is answered with `commit-result granted:true reason:null` when no `commits` dep is given;
- with `commits: async () => ({ granted: false, reason: 'gone' })` the child receives `{type:'commit-result', id, granted:false, reason:'gone'}`;
- a `commits` port that throws still answers, with `granted:false` and the error text (every request is answered, as `answerDocRequest` guarantees);
- `failed` with `superseded: true` rejects `run()` with an `AgentFailure` whose `superseded === true` and `reported === true`.

- [ ] **Step 5: Implement in `agent-handle.ts` and `agent.ts`, run to pass**

In `agent.ts`, add a `commitGate` built on the same `waiters` map as `request()`. Send `{type:'commit-request', id, kind, pluginId}`; on `commit-result`, resolve if granted, otherwise reject with `new SupersededError(reason ?? 'refused')`. Waiters need to tell doc and commit results apart by message type, so key them by id and have each waiter hold its own resolve logic.

The `agent-handle.test.ts` module-graph test (`runtimeClosure(join(here, 'agent.ts'))`) must still pass: `run-payload.ts` already lies inside that closure.

- [ ] **Step 6: Supervisor passes nothing new; the in-process `run-job.ts` passes no gate**

Confirm by reading that `createSupervisor`'s default `makeAgent` omits `commits` (so it gets `GRANT_ALL`), and that `run-job.ts` calls `runPayload` without `commitGate`. The only supervisor change here is in `settleJob`: treat `AgentFailure.superseded` like any other reported failure for now. Task 9 gives it real handling.

- [ ] **Step 7: Run worker + engine tests, typecheck, lint**

Run: `pnpm test -- packages/server/src/worker packages/engine/src/executor && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/worker packages/engine/src packages/server/src/daemon/supervisor.ts
git commit -m "feat(worker): gate every library-writing step on a commit grant, so a node whose claim was released cannot install

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Map a payload to a node and a report back

**Files:**
- Create: `packages/server/src/nodes/map-payload.ts`, `packages/server/src/nodes/map-payload.test.ts`

**Interfaces:**
- Consumes: `mapPath`, `PathMapping` (Task 1); `JobPayload`; `JobReport`, `ReplacedFile`; `LibraryRecord` (`roots`, `stagingDir`, `trashDir`)
- Produces:

```ts
export class UnmappedPathError extends Error { readonly path: string }
/** Every server path in the payload rewritten for the node. Throws UnmappedPathError. */
export const payloadToNode: (payload: JobPayload, map: readonly PathMapping[]) => JobPayload;
/** The report's paths rewritten back. Throws UnmappedPathError for a replaced path outside the map. */
export const reportToServer: (report: JobReport, map: readonly PathMapping[]) => JobReport;
/** Library roots as the node sees them; null entries for unmapped roots. */
export const libraryRootsForNode: (library: LibraryRecord, map: readonly PathMapping[]) => (string | null)[];
```

Fields rewritten by `payloadToNode`:
- `path`;
- `library.roots[]`;
- `library.stagingDir` and `library.trashDir`, when non-null;
- `logPath` set to `null`. The node host assigns its own log path, and the server writes its copy from frames (Task 8).

`pluginPaths` is not touched here; the node host rewrites it from `pluginBundles` (Task 11). `ffmpegPath`/`ffprobePath` are also left alone, because the node host overrides them with its own.

`reportToServer` rewrites `replaced.path` only. Step records carry no persisted paths; `StepRecord.logExcerpt` is free text and stays as written.

- [ ] **Step 1: Failing tests**

```ts
const map = [{ serverPath: '/media', nodePath: '/mnt/nas' }];

it('rewrites file, roots, staging and trash, and clears logPath', () => {
  const mapped = payloadToNode(
    fixturePayload({ path: '/media/movies/a.mkv', library: { roots: ['/media/movies'], stagingDir: '/media/.stage', trashDir: null } }),
    map,
  );
  expect(mapped.path).toBe('/mnt/nas/movies/a.mkv');
  expect(mapped.library.roots).toEqual(['/mnt/nas/movies']);
  expect(mapped.library.stagingDir).toBe('/mnt/nas/.stage');
  expect(mapped.library.trashDir).toBeNull();
  expect(mapped.logPath).toBeNull();
});

it('does not mutate its input', () => { /* deep-equal the original after mapping */ });

it('throws UnmappedPathError naming the path when the file is outside the map', () => {
  expect(() => payloadToNode(fixturePayload({ path: '/srv/x.mkv' }), map)).toThrow(/\/srv\/x\.mkv/);
});

it('an unmapped explicit staging dir is an error, not a silent fallback', () => { /* stagingDir '/scratch' -> throws */ });

it('maps a replaced path back, container change included', () => {
  const report = reportToServer(fixtureReport({ replaced: { path: '/mnt/nas/movies/a.mp4' } }), map);
  expect(report.replaced?.path).toBe('/media/movies/a.mp4');
});

it('a report with no replacement passes through', () => { /* replaced null -> equal */ });
```

Build `fixturePayload`/`fixtureReport` in the test from the shapes in `job-payload.test.ts`/`apply-report.test.ts`.

- [ ] **Step 2: Run (FAIL) → implement → run (PASS) → typecheck, lint**

Run: `pnpm test -- packages/server/src/nodes/map-payload.test.ts && pnpm typecheck && pnpm lint`

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/nodes/map-payload.ts packages/server/src/nodes/map-payload.test.ts
git commit -m "feat(server): translate job payloads and reports through a node's path map, refusing any path the map does not cover

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Plugin bundles (server side)

**Files:**
- Create: `packages/server/src/nodes/bundles.ts`, `packages/server/src/nodes/bundles.test.ts`
- Modify: `packages/server/src/worker/job-payload.ts` (+ test), `packages/server/src/plugins/plugin-repo.ts` (a `resolveBundleRoots(ids)` query)

**Interfaces:**
- Produces:

```ts
export interface BundleFile { relPath: string; sha256: string; sizeBytes: number }
export interface BundleManifest { files: BundleFile[] }   // sorted by relPath, byte order
export const bundleHash: (manifest: BundleManifest) => string;   // sha256 hex of JSON.stringify(manifest)
export interface BundleStore {
  /** Manifest for the tree at `root`, cached by (root, mtime of newest file) — recomputed after a sync. */
  manifestFor(root: string): Promise<{ hash: string; manifest: BundleManifest }>;
  /** The root registered under `hash` by a prior manifestFor call, or null. */
  rootFor(hash: string): string | null;
  /** Absolute path of relPath inside the bundle, or null when not listed in the manifest. */
  filePath(hash: string, relPath: string): string | null;
}
export const createBundleStore: (limits?: { maxFiles?: number; maxBytes?: number }) => BundleStore;   // defaults 20_000 files, 512 MiB

// plugin-repo.ts
resolveBundleRoots(ids: readonly string[]): Record<string, { root: string; relPath: string }>;
// root = abs_path with rel_path removed from its end (assert abs_path.endsWith(rel_path)); only rows with source_id NOT NULL.

// job-payload.ts
pluginBundles: Record<string, { bundle: string; relPath: string }>;
```

`buildJobPayload` is synchronous and hashing is async, so it fills `pluginBundles` with `{}`. The hub's `RemoteAgentHandle.run` (Task 8) fills it before sending, using `BundleStore.manifestFor` for each root. Keep `buildJobPayload` synchronous.

**Safety for `filePath`.** Only a `relPath` present in the manifest resolves. That is the containment check: a request for `../../trawlarr.db` is simply not a manifest entry. Never `join` a request path that the manifest has not listed.

**Walking.** List regular files only (`lstat`; skip symlinks and anything under a `.git` directory). Stop with a named error once `maxFiles` or `maxBytes` is exceeded.

- [ ] **Step 1: Failing tests**
  - A tree with `a/index.js`, `FlowHelpers/x.js` and a symlink produces a manifest of the two regular files, sorted, with correct sha256 and sizes.
  - `bundleHash` is stable across two builds of the same tree and changes when one byte changes.
  - `.git/HEAD` is excluded.
  - `filePath(hash, 'a/index.js')` resolves; `filePath(hash, '../outside')` and an unlisted path return null.
  - Exceeding `maxFiles: 1` throws an error naming the limit.
  - `resolveBundleRoots` strips `rel_path` and skips path-named plugins; insert plugin rows the way `plugin-repo.test.ts` does.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS)**

Run: `pnpm test -- packages/server/src/nodes/bundles.test.ts packages/server/src/plugins packages/server/src/worker/job-payload.test.ts && pnpm typecheck && pnpm lint`

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/nodes/bundles.ts packages/server/src/nodes/bundles.test.ts packages/server/src/plugins/plugin-repo.ts packages/server/src/worker/job-payload.ts packages/server/src/worker/job-payload.test.ts
git commit -m "feat(server): describe plugin source trees as content-addressed bundles, so a node runs exactly the code the server hashed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Node REST — management routes, enrollment, bundle downloads

**Files:**
- Create: `packages/server/src/nodes/node-http.ts`, `packages/server/src/nodes/node-http.test.ts`
- Modify: `packages/server/src/api/routes/nodes.ts`, `packages/server/src/api/server.ts`, `packages/server/src/api/router.ts`, `packages/server/src/api/api.test.ts` (route tests)

**Interfaces:**
- Consumes: `NodeRepo` (Task 2), `BundleStore` (Task 6)
- Produces:
  - Management routes (normal auth), under `/api/v1`:
    - `GET /nodes`: list with a live `online` flag from `ctx.nodes.isOnline(id)`, plus `running` jobs from supervisor status filtered by `nodeId`. The local node keeps its current shape; add `online: true`.
    - `POST /nodes` `{name}` → `201 { node, enrollToken, enrollExpiresAt }`
    - `POST /nodes/:id/enroll-token` → `{ enrollToken, enrollExpiresAt }`. A 409 if already enrolled.
    - `PUT /nodes/:id` `{ name?, pathMap?, schedule?, paused?, tags? }` → node. Calls `ctx.nodes.pushConfig(id)` afterwards. A 400 with `PathMapError`/`ScheduleConfigError` text.
    - `POST /nodes/:id/revoke` → node. Calls `ctx.nodes.disconnect(id, 'revoked')`.
    - `DELETE /nodes/:id` → 204. A 409 while the node has an unended job.
    - The `local` id refuses `enroll-token`, `revoke` and `DELETE` with 400.
  - Node-facing endpoints, handled by `createNodeHttpHandler({ nodes: NodeRepo, bundles: BundleStore, nowMs })` before the router:
    - `POST /api/v1/nodes/enroll` `{token}` → `{ nodeId, secret }`, or 401 `{error:'enrollment_refused'}`, one message for every refusal reason. Body capped at 4 KiB.
    - `GET /api/v1/nodes/bundles/:hash`: needs node auth → manifest JSON, or 404.
    - `GET /api/v1/nodes/bundles/:hash/files/<relPath…>`: needs node auth → `application/octet-stream` streamed with `createReadStream`, or 404.
    - Node auth: headers `X-Trawlarr-Node: <nodeId>` and `Authorization: Bearer <secret>`, checked with `NodeRepo.authenticate`. A failure is 401 with one fixed message.
  - `type NodeHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>` resolves `true` when it handled the request. `createApiHandler` options gain `nodeHttp?: NodeHttpHandler`, awaited first.
  - `ApiContext.nodes: NodeHub`, where `NodeHub` at this task is just the interface: `isOnline(id): boolean; pushConfig(id): void; disconnect(id, reason): void`. Task 8 implements it. `test-doubles.ts` gets a no-op fake.

- [ ] **Step 1: Failing tests** in `node-http.test.ts`. Start a real `http.Server` with only the node handler, against a migrated in-memory db:
  - enroll with a valid token → 200 with secret; the same token again → 401;
  - a bundle manifest without headers → 401; with a wrong secret → 401; with the right one → 200 and JSON equal to `manifestFor`;
  - a bundle file listed → bytes equal the file; `files/..%2F..%2Fetc%2Fpasswd` → 404; an unlisted file → 404;
  - a revoked node's secret → 401;
  - a request to a non-node path → the handler resolves `false` and writes nothing.

  In `api.test.ts`, cover the management routes: create → token shown; PUT with a bad path map → 400 with message; revoke calls `nodes.disconnect` (spy); DELETE `local` → 400.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS)**

Run: `pnpm test -- packages/server/src/nodes packages/server/src/api && pnpm typecheck && pnpm lint`

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/nodes/node-http.ts packages/server/src/nodes/node-http.test.ts packages/server/src/api
git commit -m "feat(api): enroll nodes with single-use tokens and serve plugin bundles only to authenticated nodes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Node hub and RemoteAgentHandle (server side of the socket)

**Files:**
- Create: `packages/server/src/nodes/hub.ts`, `packages/server/src/nodes/remote-agent.ts`, `packages/server/src/nodes/hub.test.ts`, `packages/server/src/nodes/remote-agent.test.ts`

**Interfaces:**
- Consumes: frames (Task 3), lease functions (Task 1), `NodeRepo`, `JobRepo` lease methods (Task 2), `payloadToNode`/`reportToServer` (Task 5), `BundleStore` + `PluginRepo.resolveBundleRoots` (Task 6), `AgentHandle`, `AgentFailure`, `AgentFactoryInput`, `JobPayload`, `JobReport`, `createJobLogWriter`, `createMediaFileRepo`
- Produces:

```ts
// remote-agent.ts
export interface RemoteJobChannel {
  /** Send to the node now; returns false when the node is offline (caller queues). */
  send(frame: ServerFrame): boolean;
}
export interface RemoteAgentInput extends AgentFactoryInput {
  nodeId: string;
  /** Present for a fresh job; absent for an adopted one (daemon restart). */
  fresh: boolean;
  channel: () => RemoteJobChannel | null;      // current connection for nodeId, or null
  decideCommit: (request: { kind: 'replace' | 'plugin'; pluginId: string }) => { granted: boolean; reason: string | null };
  onStepLease: () => void;                     // leaseAfterStep persisted by hub
  prepare: (payload: JobPayload) => Promise<JobPayload>;   // bundles + path map
  appendLog: (text: string) => void;           // server-side job log file
}
export interface RemoteAgentHandle extends AgentHandle {
  readonly nodeId: string;
  /** Hub → handle: a frame for this job arrived. */
  receive(message: AgentToDaemon): void;
  /** Hub → handle: the lease expired or the node reported the job lost. */
  abandon(failure: AgentFailure): void;
  /** Hub → handle: the node reconnected; flush any queued cancel. */
  reconnected(): void;
}
export const createRemoteAgentHandle: (input: RemoteAgentInput) => RemoteAgentHandle;

// hub.ts
export interface NodeHub {
  attach(server: import('node:http').Server): void;
  isOnline(nodeId: string): boolean;
  onlineNodes(): OnlineNode[];
  pushConfig(nodeId: string): void;
  disconnect(nodeId: string, reason: string): void;
  createAgent(input: AgentFactoryInput & { nodeId: string }): RemoteAgentHandle;
  /** Daemon start: rebuild handles for every leased job, moving leases to grace from now. */
  adoptLeasedJobs(): { payload: JobPayload; agent: RemoteAgentHandle; nodeId: string }[];
  sweepLeases(): void;
  close(): Promise<void>;
}
export interface OnlineNode {
  nodeId: string;
  schedule: ScheduleConfig;
  paused: boolean;
  hardware: { available: HardwareType[]; caps: Partial<Record<HardwareType, number>> };
  reachableLibraryIds: ReadonlySet<string>;
}
export const NODE_SOCKET_PATH = '/api/v1/nodes/connect';
export const createNodeHub: (input: {
  db: Db; nodes: NodeRepo; bundles: BundleStore; settings: SettingsRepo; bus: EventBus;
  nowMs: () => number; buildVersion: string;
  /** Hook the supervisor tick so a node coming online (or its config changing) starts work promptly. */
  onNodesChanged: () => void;
  pingIntervalMs?: number;  // default 15_000
  offlineAfterMs?: number;  // default 45_000
}) => NodeHub;
```

**Behaviour of `createRemoteAgentHandle`:**
- `run(payload)` when `fresh`:
  1. `prepared = await prepare(payload)`. It resolves bundles for installed plugins, then `payloadToNode` with the node's current map.
  2. `jobRepo.setRemote({ jobId, nodeId, lease: leaseOnClaim(), payloadJson: JSON.stringify(payload) /* server view */, pathMapJson })`.
  3. Send `{type:'job', jobId, payload: prepared}`.

  If `prepare` throws (`UnmappedPathError`, bundle errors), reject with `AgentFailure(reported: true)` carrying the message. The supervisor then records a normal failed attempt.
- When not `fresh` (adopted), `run` sends nothing and waits.
- `receive(message)` mirrors `createAgentHandle`'s `child.on('message')` switch:
  - `step` → `onStep` + `onStepLease()`;
  - `heartbeat` → `onHeartbeat`;
  - `progress` → `onProgress`;
  - `log` → `onLog` + `appendLog`;
  - `doc-request` → answer through `input.documents` and send `{type:'agent', jobId, message: doc-result}`. Copy `answerDocRequest`'s logic by extracting it from `agent-handle.ts` into an exported `answerDocRequest(documents, request, post)` helper both files use;
  - `commit-request` → `decideCommit(...)`, sent back as `commit-result`;
  - `done` → `reportToServer(report, map)` with the map from `job.path_map_json`, then resolve;
  - `failed` → reject with `AgentFailure(reported: true, superseded, cancelled)`;
  - `ready` → ignored.
- `cancel()`: send `{type:'agent', jobId, message:{type:'cancel'}}`. If `send` returns false, set `pendingCancel = true`; `reconnected()` flushes it. There is no kill ladder here: the node host owns the process group.
- `kill()`: same as cancel. The daemon cannot signal a remote pid.
- `pid` is `undefined`, and `exited` resolves when the run settles.
- `abandon(failure)`: reject if not settled; send `{type:'abandon', jobId, reason}` if connected.
- `settled()`: send `{type:'ack-report', jobId}` if connected. Otherwise the node re-announces `held-report` on reconnect, and the hub then acks without re-applying: the job row has already ended.

**Behaviour of `createNodeHub`:**
- `attach` adds an `upgrade` listener that only handles `NODE_SOCKET_PATH`; every other path is left for `attachWebSocket`. Check `ws.ts`'s listener: it must also ignore non-`/api/v1/events` paths rather than 404ing them. Fix that there if needed, with a test. It authenticates `X-Trawlarr-Node` + `Authorization: Bearer` via `NodeRepo.authenticate` before `handleUpgrade`, denying with 401 like `ws.ts`'s `denyUpgrade`. It uses `new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })`.
- A second connection for an already-connected node id closes the older one with code 4000 `replaced`. That way a node that restarted fast is not refused by its own ghost.
- The first frame must be `hello` within 10 s, or close with 4001.
  - A `protocolVersion` that differs from `PROTOCOL_VERSION` gets `refused` naming both versions, `retryAfterMs: 300_000`, then close 4002.
  - Otherwise: `nodes.recordHello`, then reconcile each `hello.jobs` entry against `jobRepo.getById` and the in-memory handles, per the spec's re-attach table:
    - `running` + row unended + lease not expired → `continue`; lease → `leaseOnReconnect`; `handle.reconnected()`;
    - `running` + row ended or expired → `abandon`;
    - `held-report` + row unended → `apply-report`. The node then re-sends its `done` inside an `agent` frame, which reaches `handle.receive`;
    - `held-report` + row ended → `abandon`. The node deletes its entry; the hub appends "`A late result arrived from node <name> after this job was released: …`" when the `done` arrives. It gets there because the hub routes an `agent` frame for an ended job to `jobRepo.appendOutcome` instead of a handle;
    - `lost` → `lost`, and `handle.abandon(new AgentFailure('Node <name> restarted while running this job.', { reported: false }))`;
    - a leased unended job for this node that `hello.jobs` does not mention → treat as `lost`.

    Each entry gets `logLinesHave`: the line count of the server's log file for that job (count `\n` in the file, or 0).
  - Send `welcome` with the current config (`NodeConfigFrame`: map, schedule, paused, and every library with `libraryRootsForNode`), then call `onNodesChanged()`.
- `libraries` frame → `nodes.recordLibraries`, then `onNodesChanged()`.
- `log-backfill` → append the lines to the job's server log file, prefixed `[backfill]` on the first line.
- Ping every `pingIntervalMs`; terminate after `offlineAfterMs` without a pong.
- On close: for each unended leased job on that node, `setLease(leaseOnDisconnect(...))` with `settings.getNodes().leaseGraceMs`; `nodes.touch`; `onNodesChanged()`; emit `nodes.changed` on the bus (add that event type to `daemon/events.ts`).
- `sweepLeases()`, called every 60 s by the daemon, for each `listLeased()` row:
  - if `leaseIsExpired` → `setLease({state:'expired'})` and `handle.abandon(new AgentFailure(\`Node ${name} was offline for longer than the ${minutes}-minute grace window, so this file was released.\`, { reported: false }))`;
  - if the lease is `connected` and the job's last activity (`heartbeatAt ?? startedAt`) is older than `DEFAULT_STALE_AFTER_MS` → the same abandon, with a message naming 24 h of silence, and send `abandon` to the node.
- `decideCommit` for a handle: `stillClaimed` = the media file's `state === 'running'` and `jobRepo.listForFile(fileId)[0]?.id === jobId` with `endedAt === null`. Persist the resulting lease.
- `adoptLeasedJobs()`: for each `listLeased()` row, `setLease(leaseOnDaemonStart(...))` and build a handle with `fresh: false` from `JSON.parse(payloadJson)`.

- [ ] **Step 1: Failing `remote-agent.test.ts`** (pure unit, fake channel):
  - a fresh `run` sends exactly one `job` frame whose payload paths are mapped and whose `pluginBundles` are filled; the job row gains a `connected` lease and a server-view `payload_json`;
  - `done` with node paths resolves with server paths;
  - `commit-request` while the decision says refused → `commit-result granted:false` sent;
  - `cancel` while the channel returns false is delivered after `reconnected()`;
  - `abandon` rejects `run` once; a later `done` is ignored;
  - `settled()` sends `ack-report`.
- [ ] **Step 2: Failing `hub.test.ts`**, using a real `http.Server` on port 0 and a real `ws` client:
  - an upgrade with no or bad credentials → 401 before any socket opens;
  - a mismatched `protocolVersion` → `refused` naming both, then close 4002;
  - a valid hello → `welcome` with the path map and mapped library roots; `isOnline` true; `onNodesChanged` called;
  - close → the leased job moves to `grace` with `expiresAt = now + grace`;
  - the fake clock passes grace, then `sweepLeases()` → the handle's `run` rejects with the grace message and the lease is `expired`;
  - reconnect with `running` inside grace → `continue`, lease `connected`;
  - reconnect with `running` after expiry → `abandon`;
  - a commit decision after expiry → refused;
  - a second connection replaces the first (the old socket receives 4000);
  - `adoptLeasedJobs` after "restart" (a new hub on the same db) → leases are `grace` from the new now, one handle per job;
  - a `held-report` + `done` for a job that already ended → no ledger change (the media file row is unchanged) and the outcome is appended.
- [ ] **Step 3: Run (FAIL) → implement → run (PASS)**

Run: `pnpm test -- packages/server/src/nodes && pnpm typecheck && pnpm lint`

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/nodes packages/server/src/worker/agent-handle.ts packages/server/src/api/ws.ts packages/server/src/daemon/events.ts
git commit -m "feat(server): accept node sockets and run remote jobs through the same agent handle contract, holding leases across disconnects

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Supervisor schedules across nodes; reaper and daemon wiring

**Files:**
- Modify: `packages/server/src/daemon/supervisor.ts`, `packages/server/src/daemon/supervisor.test.ts`, `packages/server/src/worker/reap-stalled.ts`, `packages/server/src/worker/reap-stalled.test.ts`, `packages/server/src/daemon/daemon.ts`, `packages/server/src/daemon/daemon.test.ts`, `packages/server/src/api/routes/workers.ts` (status carries `nodeId`)

**Interfaces:**
- Consumes: `NodeHub`, `OnlineNode`, `RemoteAgentHandle` (Task 8)
- Produces:

```ts
// supervisor.ts
export interface CreateSupervisorInput {
  // …existing…
  /** Remote nodes currently online. Absent in tests that only exercise the local node. */
  remoteNodes?: () => OnlineNode[];
  createRemoteAgent?: (input: AgentFactoryInput & { nodeId: string }) => AgentHandle;
}
export interface SupervisorWorkerStatus { /* existing */ nodeId: string }
export interface Supervisor {
  // …existing…
  /** Track a run that was already claimed and started before this process (daemon restart). */
  adopt(input: { payload: JobPayload; agent: AgentHandle; nodeId: string }): void;
}
```

**Reconcile changes.** Build a list of node views:

```ts
interface NodeView {
  nodeId: string;
  target: Record<WorkerClass, number>;
  hardware: HardwareSettings;
  reachable: ReadonlySet<string> | null;   // null = local: every library
  paused: boolean;
}
```

- The local view comes from `settings.getSchedule()` / `settings.getHardware()` with `reachable: null`.
- Remote views come from `remoteNodes()`, using `evaluateSchedule({schedule: node.schedule, nowMs})`.

For each view that is not paused, and while the global `paused`/`draining` flags allow, for each class run the existing loop with:
- `activeOf(nodeId, class)`;
- `usedHardware(nodeId)`;
- `eligibleLibrariesFor({db, hardware: view.hardware, used})` filtered to `view.reachable`.

`startWorker` gains `nodeId`:
- `jobRepo.start({ …, nodeId })`;
- the agent comes from `nodeId === LOCAL_NODE_ID ? makeAgent(...) : input.createRemoteAgent!({...factoryInput, nodeId})`;
- `jobRepo.setWorker` is called only for local.

Import `LOCAL_NODE_ID` from a new tiny module `packages/server/src/nodes/local-node.ts` (move the constant there and re-export it from `api/routes/nodes.ts`). Otherwise the supervisor would import an API route file.

**Settlement changes.**
- An `AgentFailure` with `superseded === true` → `jobRepo.appendOutcome` with the refusal text, and no ledger write: the row was already released and stalled at expiry. Emit `job.finished` with the file's current state.
- After `settleJob`, call `agent.settled?.()`.

`adopt` inserts a slot for an existing payload without claiming or starting a job row, then chains the same `.run().then(settle)` as `startWorker`. Extract that chain into `trackRun(slot, payload)` and use it from both.

**Reaper.**
- `workerProvablyGone` requires `latest.nodeId === LOCAL_NODE_ID` instead of `latest.workerHost !== hostname()`. Keep the host check as well, so rows from before this change with `node_id NULL` keep today's behaviour: allow `nodeId === null && workerHost === hostname()`.
- Skip any row whose latest job has `leaseState !== null && endedAt === null`, counting it `live`. The hub's sweep owns leased jobs.

**Daemon.**
- Construct `createBundleStore()`, `createNodeRepo(db)` and `createNodeHub({... onNodesChanged: () => void supervisor.tick()})`.
- Pass `remoteNodes: () => hub.onlineNodes()` and `createRemoteAgent: hub.createAgent` to the supervisor.
- `hub.attach(server)` before `attachWebSocket`.
- After the supervisor exists and before the first tick: `for (const job of hub.adoptLeasedJobs()) supervisor.adopt(job)`.
- A `setInterval(hub.sweepLeases, 60_000)` cleared on shutdown.
- `createNodeHttpHandler` goes into the API handler options.
- `await hub.close()` in shutdown, after drain. Remote jobs are not cancelled on daemon shutdown, because they survive restarts by design. `drain()` must therefore not wait on remote slots: `awaitAll` filters to local slots when draining for shutdown. Add `drain({ includeRemote: false })`.

- [ ] **Step 1: Failing supervisor tests** (fake agents via `createAgent`/`createRemoteAgent`; `remoteNodes` returns a controllable list):
  - a remote node with target 2 and a reachable library claims 2 files onto that node while local claims its own target; `status().workers` carries the right `nodeId`s;
  - a remote node whose `reachable` set excludes a library never claims from it;
  - a remote node declaring only `cpu` never claims a library whose flow requires `nvenc`;
  - a paused remote node claims nothing, while local still does;
  - a remote failure with `superseded` leaves the media file row byte-for-byte unchanged and appends the outcome;
  - `settled()` is called exactly once, after the job row has ended;
  - `adopt` occupies a slot (the node's active count includes it) and its settlement writes the outcome;
  - `drain({ includeRemote: false })` resolves while a remote run is still pending.
- [ ] **Step 2: Failing reaper tests**:
  - a running job with `node_id = 'node-x'`, `worker_host = hostname()` and a dead pid is not reclaimed by the fast path;
  - a job with `lease_state = 'grace'` and heartbeat 25 h old → counted `live`, not reclaimed;
  - the existing local tests still pass with `node_id = 'local'`; a legacy row with `node_id NULL` and the same host still fast-paths.
- [ ] **Step 3: Failing daemon test**: start the daemon with a job row leased to `node-x` in `connected`; assert that after start the row is in `grace` with `expiresAt = start + grace` and the supervisor status lists a slot for `node-x`.
- [ ] **Step 4: Run (FAIL) → implement → run (PASS)**

Run: `pnpm test -- packages/server/src/daemon packages/server/src/worker packages/server/src/api && pnpm typecheck && pnpm lint`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src
git commit -m "feat(daemon): schedule work across online nodes and adopt remote jobs after a restart instead of releasing them

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Node-side journal and bundle cache

**Files:**
- Create: `packages/server/src/node/journal.ts`, `packages/server/src/node/journal.test.ts`, `packages/server/src/node/bundle-cache.ts`, `packages/server/src/node/bundle-cache.test.ts`, `packages/server/src/node/node-state.ts`, `packages/server/src/node/node-state.test.ts`

**Interfaces:**
- Produces:

```ts
// journal.ts
export interface JournalEntry {
  jobId: string;
  state: 'running' | 'held-report';
  /** The agent's final message, kept until the server acks it. */
  final: AgentToDaemon | null;          // a 'done' or 'failed' message
  logLines: string[];                   // bounded tail
  logLineCount: number;                 // total lines ever appended (for backfill offsets)
  startedAtMs: number;
}
export const JOURNAL_LOG_TAIL = 5_000;
export interface Journal {
  /** Entries on disk at startup; any 'running' entry becomes 'lost' here, because no agent survives a node restart. */
  load(): { jobId: string; state: 'running' | 'held-report' | 'lost'; logLineCount: number }[];
  begin(jobId: string, nowMs: number): void;
  appendLog(jobId: string, line: string): void;
  hold(jobId: string, final: AgentToDaemon): void;
  get(jobId: string): JournalEntry | null;
  linesFrom(jobId: string, fromLine: number): { fromLine: number; lines: string[] };   // clamps to retained tail
  remove(jobId: string): void;
}
export const createJournal: (dir: string) => Journal;   // <nodeData>/journal/<jobId>.json, written via write-to-temp + rename

// bundle-cache.ts
export interface BundleCache {
  /** Ensure the bundle is present and verified; returns its root directory. */
  ensure(hash: string): Promise<string>;
  prune(maxBytes: number): Promise<void>;
}
export const createBundleCache: (input: {
  dir: string;                              // <nodeData>/bundles
  fetchManifest: (hash: string) => Promise<unknown>;
  fetchFile: (hash: string, relPath: string) => Promise<Buffer>;
}) => BundleCache;

// node-state.ts
export interface NodeState { serverUrl: string; nodeId: string; secret: string }
export const readNodeState: (dataDir: string) => Promise<NodeState | null>;
export const writeNodeState: (dataDir: string, state: NodeState) => Promise<void>;   // node.json, mode 0o600, temp + rename
```

**Journal writes.**
- `appendLog` updates memory on every call, but the file is rewritten at most once per second while running, plus synchronously on `hold` and `remove`. Log lines are not durable-critical; the held report is.
- On `load`, an entry with `state: 'running'` is rewritten as lost. Keep it on disk until the server acks the loss; add `markLostAcked` by calling `remove` after the `welcome` action `lost`.

**Bundle cache.**
- Download into `<dir>/<hash>.partial-<random>/`.
- Validate the manifest shape and `bundleHash(manifest) === hash`. Import `bundleHash` from `../nodes/bundles.js`; that module must not import `db`, so check it.
- Write each file, creating subdirectories. Reject any relPath that is absolute, contains `..`, or resolves outside the partial dir.
- Verify each file's sha256 and size, then rename the dir to `<dir>/<hash>/`. A present `<hash>/` directory is trusted as complete, because only a verified download is ever renamed into place.
- Touch a `.last-used` file on `ensure`. `prune` removes least-recently-used bundles until the total is under `maxBytes`; `ensure` never prunes a bundle it is about to return.

- [ ] **Step 1: Failing journal tests**:
  - `begin` → `hold` → a new `createJournal` on the same dir → `load` reports `held-report`, and `get` returns `final`;
  - `begin` alone → reload → `lost`;
  - `appendLog` beyond `JOURNAL_LOG_TAIL` keeps the last 5,000 lines with `logLineCount` equal to the total; `linesFrom(total - 10)` returns 10 lines, and `linesFrom(0)` clamps to the tail start;
  - a torn write (a leftover temp file) is ignored on load.
- [ ] **Step 2: Failing bundle-cache tests** with in-memory fake fetchers built from a real `createBundleStore` over a temp tree:
  - `ensure` produces a directory whose files equal the source; a second `ensure` performs no fetch;
  - a file whose bytes are tampered with → rejects, and no `<hash>/` dir exists;
  - a manifest whose hash mismatches → rejects;
  - a relPath `../x` in a manifest → rejects;
  - `prune` removes the older of two bundles.
- [ ] **Step 3: Failing node-state tests**: round trip; file mode `0o600`; missing → null; malformed JSON → throws naming the file.
- [ ] **Step 4: Run (FAIL) → implement → run (PASS)**

Run: `pnpm test -- packages/server/src/node && pnpm typecheck && pnpm lint`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/node
git commit -m "feat(node): journal held reports until the server acks them and cache only verified plugin bundles

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Node host runtime and `trawlarr node`

**Files:**
- Create: `packages/server/src/node/node-host.ts`, `packages/server/src/node/node-host.test.ts`
- Modify: `packages/server/src/cli.ts` (+ `cli.test.ts`), `packages/server/src/worker/agent-handle.test.ts` (extend the module-graph guard to `node/node-host.ts`)

**Interfaces:**
- Consumes: `createAgentHandle` + `CommitPort` (Task 4), frames (Task 3), `Journal`, `BundleCache`, `NodeState` (Task 10), `preflightHardware` from `daemon/hardware-preflight.ts` (check that it imports no `db`; if it does, extract the ffmpeg-only part), `DAEMON_VERSION`, and the kernel file lock from `daemon/lockfile.ts` / `os-file-lock.ts` (use the OS lock with filename `node.lock`)
- Produces:

```ts
export interface NodeHostInput {
  dataDir: string;
  serverUrl?: string;          // required on first run (with enrollToken)
  enrollToken?: string;
  ffmpegPath: string;
  ffprobePath: string;
  hardware: { available: HardwareType[]; caps: Partial<Record<HardwareType, number>> };
  nowMs?: () => number;
  /** Seams for tests. */
  createAgent?: typeof createAgentHandle;
  WebSocketImpl?: typeof WebSocket;
  fetchFn?: typeof fetch;
  reconnectDelaysMs?: readonly number[];   // default [1_000, 2_000, 5_000, 10_000, 30_000]
  libraryProbeIntervalMs?: number;          // default 300_000
}
export interface NodeHost {
  /** Resolves once connected at least once, or rejects on a refusal it cannot retry (enrollment refused). */
  started: Promise<void>;
  status(): { connected: boolean; nodeId: string | null; running: string[] };
  stop(): Promise<void>;    // cancels running agents, closes the socket, releases the lock
}
export const startNodeHost: (input: NodeHostInput) => Promise<NodeHost>;
```

**Behaviour:**
1. Acquire `<dataDir>/node.lock`, then `readNodeState`.
   - If absent: POST `${serverUrl}/api/v1/nodes/enroll` `{token}`, `writeNodeState`.
   - Enrollment 401 → reject `started` with "The enrollment token was refused: it is wrong, expired, or already used. Create a new one on the server's Nodes page." (exit code 2 in the CLI).
2. Connect to `ws(s)://…/api/v1/nodes/connect` with the node headers. `http:` becomes `ws:`, and `https:` becomes `wss:`.
3. Send `hello` with journal `load()` results.
   - On `refused`: log it, wait `retryAfterMs`, reconnect.
   - On close for another reason: back off through `reconnectDelaysMs`, repeating the last value.
4. On `welcome`/`config`:
   - store the config;
   - for each `hello` job, act on its action: `continue` (nothing), `abandon` (cancel the agent, remove the journal entry), `apply-report` (re-send `{type:'agent', jobId, message: entry.final}`), `lost` (remove);
   - for `continue`/`apply-report` with `logLinesHave < logLineCount`, send `log-backfill` from `linesFrom(logLinesHave)`;
   - probe libraries: for each `nodeRoots` entry, `stat` it. Unreachable when null ("not mapped") or when stat fails (the error code). A library is reachable only if every root is. Send `libraries`;
   - re-probe on `libraryProbeIntervalMs`.
5. On `job`:
   - `journal.begin`;
   - for each `pluginBundles[id]`, `root = await bundleCache.ensure(bundle)` and `pluginPaths[id] = join(root, relPath)`;
   - set `logPath = <dataDir>/logs/jobs/<jobId>.log`, and `ffmpegPath`/`ffprobePath` from input;
   - `agent = createAgent({ id: jobId, documents: remoteDocuments(jobId), commits: remoteCommits(jobId), onStep/onHeartbeat/onProgress → send agent frames, onLog → journal.appendLog + send log frame, nowMs })`;
   - `agent.run(payload)`:
     - on resolve → `journal.hold(jobId, {type:'done', report})`, then send;
     - on reject → `journal.hold(jobId, {type:'failed', error, superseded})`, then send.
   - Bundle fetch errors → hold `failed` naming the plugin and bundle.
6. `remoteDocuments` and `remoteCommits` send `doc-request`/`commit-request` inside `agent` frames with node-host-assigned ids. They wait for the matching `agent` reply and survive reconnects: pending requests stay pending, and are re-sent after a reconnect whose `welcome` says `continue` for that job.

   Commit requests are never answered locally. Only a real `commit-result granted:true` from the server grants.
7. On `agent` frames from the server:
   - `cancel` → `agent.cancel()`;
   - `doc-result`/`commit-result` → resolve the pending request.
8. On `abandon` → `agent.cancel()`, and remember the job id, so a later `commit-request` for it resolves refused locally. Refusing locally is safe, because refusal never writes.
9. On `ack-report` → `journal.remove(jobId)`.
10. The node's own concurrency is whatever the server sends. The node does not enforce counts, because the server claims per node; it only rejects a `job` frame when it is already running that job id.

**CLI:** `trawlarr node [--server URL] [--token TOKEN] [--data-dir DIR] [--ffmpeg PATH] [--ffprobe PATH] [--hardware cpu,nvenc] [--cap nvenc=2]`.
- Environment fallbacks: `TRAWLARR_SERVER`, `TRAWLARR_NODE_TOKEN`, `TRAWLARR_DATA_DIR`, `TRAWLARR_FFMPEG`, `TRAWLARR_FFPROBE`, `TRAWLARR_HARDWARE`.
- Runs `preflightHardware` and logs findings.
- Handles SIGTERM/SIGINT by `stop()` then exit 0.
- Prints `Connected to <server> as <nodeId>.` on first connect.

- [ ] **Step 1: Failing `node-host.test.ts`**, driving a fake server built from `ws`'s `WebSocketServer` on port 0 plus a tiny `http` handler for enroll and bundles, with fake `createAgent`:
  - first run enrolls, writes `node.json`, sends `hello` with an empty job list;
  - a `job` frame fetches the bundle, calls `createAgent().run` with rewritten `pluginPaths`, the node-local `logPath`, and the node's ffmpeg paths;
  - the agent's `done` is journaled before it is sent: kill the socket before sending, restart the host, and the new `hello` lists `held-report`;
  - `apply-report` re-sends the held `done`; `ack-report` removes the journal entry;
  - `commit-request` while disconnected stays pending, and is granted only after reconnect plus a server `commit-result`;
  - `abandon` cancels the agent;
  - a `refused` frame with `retryAfterMs: 50` causes one reconnect after about 50 ms, not a hot loop: count connections in 200 ms and expect at most 2;
  - library probing reports an unmapped root as `not mapped` and a missing directory with its error code;
  - a second `startNodeHost` on the same data dir rejects with the lock error.
- [ ] **Step 2: Extend the module-graph guard**: `runtimeClosure(join(here, '../node/node-host.ts'))` contains nothing under `src/db/`.
- [ ] **Step 3: Failing CLI test**: `trawlarr node` with no state and no `--token` exits 2 with a message naming `--server` and `--token`.
- [ ] **Step 4: Run (FAIL) → implement → run (PASS)**

Run: `pnpm test -- packages/server/src/node packages/server/src/cli.test.ts packages/server/src/worker/agent-handle.test.ts && pnpm typecheck && pnpm lint`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/node packages/server/src/cli.ts packages/server/src/cli.test.ts packages/server/src/worker/agent-handle.test.ts
git commit -m "feat(node): run remote jobs through the unchanged agent, holding every report on disk until the server acknowledges it

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: End-to-end — real daemon, real node process

**Files:**
- Create: `packages/server/test/remote-node-end-to-end.test.ts`
- Modify: `packages/server/test/helpers/daemon-harness.ts` (add helpers to spawn `node packages/server/dist/cli.js node …` and to sever a node's TCP connection)

Model the setup on `packages/server/test/daemon-end-to-end.test.ts`: a real built daemon, real ffmpeg gated by `test-support/tool-availability.ts`, and media generated with `lavfi testsrc`.

**Setup per test:**
- Temp dirs `lib/` (the server's library root) and `nodeview/`, a symlink to `lib/`. The node sees the same files at a different path; symlink resolution keeps renames on one filesystem.
- A library at `lib/`, and a flow of Execute (`libx264` → mkv) → Replace Original File.
- Set the local node's worker count to 0, so only the remote node can take the job.
- Create a node via `POST /nodes`, set its path map `{serverPath: lib, nodePath: nodeview}` and its schedule to 1 transcode worker.
- Spawn the node process with `--token`.

**Severing a connection.** Put a tiny TCP proxy between node and daemon (`net.createServer` piping to the daemon port), with `sever()` destroying both sockets and `pause()` refusing new connections. The node's `--server` points at the proxy.

**Cases (one `it` each; use the helpers):**
1. **Completes.** The file is transcoded, the row is `good`, and `job.node_id` is the node's id. The replaced path is recorded in server view, and the job log on the server contains lines from the node.
2. **Survives a blip.** `sever()` during Execute (wait for a `job.progress` event), then un-pause after 2 s. The job completes, and the lease row was `grace` while severed (poll the DB).
3. **Released file is never installed.** Start the daemon with `nodes.leaseGraceMs = 300_000` and a controllable clock. The harness passes `TRAWLARR_TEST_NOW_OFFSET_FILE` if such a seam exists; if not, add a test-only settings override `nodes.leaseGraceMs` minimum bypass behind `NODE_ENV === 'test'`, and state that in a comment.
   1. `pause()` + `sever()` mid-Execute.
   2. Advance past grace, then trigger `sweepLeases`.
   3. Assert the row is out of `running` (held with backoff) and the job row ended with the grace message.
   4. Un-pause; the node reconnects and reaches Replace.
   5. Assert the original file's bytes are identical to before the job, the node's staging dir under `nodeview/.trawlarr/staging` is empty, and no second `good` identity exists.
4. **Node restart with a held report.** Configure the fake/real agent to finish. `pause()`, let the job finish while the node is disconnected (journal shows `held-report`), kill the node process, restart it, un-pause. The report is applied exactly once: one job row ended `done`, `media_file` is `good`, and the journal dir is empty.
5. **Revoke mid-job.** `POST /nodes/:id/revoke` → the node process logs refusal and keeps retrying; the lease is `grace`; `GET /nodes` shows revoked.
6. **Protocol mismatch.** Start the node with an env override `TRAWLARR_PROTOCOL_VERSION_OVERRIDE=1`. This is a test-only seam read in `node-host.ts` only when `NODE_ENV === 'test'`. The node logs the refusal naming both versions, and the daemon has no online node.
7. **Cancel while offline.** `pause()` + `sever()`, `POST /jobs/:id/cancel` (check the existing route name in `api/routes/jobs.ts`), un-pause. The node receives the cancel, and the file is requeued unpenalised.
8. **Bundle cached.** A flow using a locally-synced plugin source (use the fixture source `plugin-install-end-to-end.test.ts` uses). Two files are processed sequentially, and the daemon's bundle file endpoint is hit once per file in the bundle, not twice. Count via a request counter exposed on the proxy.

- [ ] **Step 1: Write the helpers and case 1; run and verify it fails for the right reason before any fix is needed.** It should pass if Tasks 1–11 are right. If it fails, debug with superpowers:systematic-debugging, not by loosening the test.

Run: `pnpm build && pnpm test -- packages/server/test/remote-node-end-to-end.test.ts`

- [ ] **Step 2: Add cases 2–8 one at a time, running after each.**
- [ ] **Step 3: Verify the suite does not silently skip.** Run with ffmpeg present and confirm `8 passed`, not skipped.
- [ ] **Step 4: Commit**

```bash
git add packages/server/test
git commit -m "test(server): prove a remote node survives disconnects and never installs over a file that was released

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Nodes tab in the web UI

**Files:**
- Create: `packages/web/src/screens/config/Nodes.tsx`, `packages/web/src/screens/config/nodes-model.ts`, `packages/web/src/screens/config/nodes-model.test.ts`
- Modify: `packages/web/src/screens/config/Config.tsx` (add `{ tab: 'nodes', label: 'Nodes' }`), `packages/web/src/shell/route.ts` (+ `route.test.ts`, accept `tab=nodes`), `packages/web/src/api/events.ts` (handle `nodes.changed` as a staleness signal, like `workers.changed`)

**Interfaces:**
- Consumes: the `GET/POST/PUT/DELETE /nodes` routes (Task 7)
- Produces (model):

```ts
export interface NodeResource {
  id: string; name: string; local: boolean; online: boolean; revokedAt: number | null; enrolled: boolean;
  lastSeenAt: number | null; buildVersion: string | null; hardwareTypes: string[];
  pathMap: { serverPath: string; nodePath: string }[]; paused: boolean;
  schedule: { baseCounts: { transcode: number; health: number } } & Record<string, unknown>;
  libraries: { libraryId: string; reachable: boolean; detail: string }[];
  running: { jobId: string; path: string; percent: number | null }[];
}
export type NodeStatusLabel = 'Online' | 'Offline' | 'Revoked' | 'Waiting to join';
export const nodeStatus: (node: NodeResource) => NodeStatusLabel;
export const pathMapRows: (map: NodeResource['pathMap']) => { serverPath: string; nodePath: string; key: string }[];
export const validatePathMapRows: (rows: { serverPath: string; nodePath: string }[]) => string | null;   // first error or null; mirrors core rules
export const joinCommand: (input: { serverUrl: string; token: string; version: string }) => { docker: string; cli: string };
export const unreachableSummary: (node: NodeResource, libraryNames: Record<string, string>) => string[];   // e.g. 'Movies: not found'
```

**UI (terse copy):**
- **List:** name, status pill, running count, last seen.
- **Add node** → name → dialog showing the token once, with two copyable commands (Docker and CLI) and "Expires in 24 h".
- **Detail panel:**
  - Workers: transcode count, reusing the Workers tab's count control component if one is exported; if not, a number input;
  - Paused toggle;
  - Paths table: two columns, *Server path* / *This node's path*, with add/remove rows and Save;
  - Libraries list with ✓ or the reason;
  - Hardware;
  - Revoke (confirm), and Delete when revoked or never enrolled.
- The local node appears first, read-only apart from a link to the Workers tab.

Match existing Config tab patterns in `Config.tsx` (`WorkersTab`) for data fetching, staleness and error display.

- [ ] **Step 1: Failing model tests**:
  - `nodeStatus` for each combination (revoked wins over online; not enrolled → 'Waiting to join');
  - `validatePathMapRows` flags relative paths, `..`, and duplicate server paths, and accepts valid rows;
  - `joinCommand` produces `docker run -d --name trawlarr-node -e TRAWLARR_MODE=node -e TRAWLARR_SERVER=<url> -e TRAWLARR_NODE_TOKEN=<token> -v trawlarr-node:/config ghcr.io/rgregg/trawlarr:<version>` and `trawlarr node --server <url> --token <token>`;
  - `unreachableSummary` names each unreachable library with its detail.
- [ ] **Step 2: Run (FAIL) → implement model → run (PASS)**

Run: `pnpm test -- packages/web/src/screens/config/nodes-model.test.ts packages/web/src/shell/route.test.ts`

- [ ] **Step 3: Build `Nodes.tsx` and wire the tab.** Run `pnpm --filter @trawlarr/web build` and `pnpm typecheck && pnpm lint`. Then use the `run` skill to launch the daemon and web UI, open `/config?tab=nodes`, add a node, and confirm the token dialog and path-table save work against a real daemon. Take a screenshot as evidence.
- [ ] **Step 4: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): add a nodes tab to enroll machines, map their paths and see why a library is unreachable

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Docker node mode and documentation

**Files:**
- Modify: `docker/entrypoint.sh`, `docker/entrypoint.test.ts`, `docker/compose-contract.test.ts`, `README.md`
- Create: `docker/compose.node.yml`

**Interfaces:**
- Consumes: `trawlarr node` CLI (Task 11)

**Entrypoint.** After the chown block, and before `exec gosu`:

```bash
# A NODE runs jobs for a server elsewhere: no database, no web UI, no port.
# Selected by environment rather than a different image, so a GPU host runs
# exactly the build its server does.
if [ "${TRAWLARR_MODE:-server}" = "node" ] && [ "$#" -eq 0 -o "${1:-}" = "trawlarr" ]; then
  set -- node /app/packages/server/dist/cli.js node
fi
if [ "${TRAWLARR_MODE:-server}" != "server" ] && [ "${TRAWLARR_MODE:-server}" != "node" ]; then
  echo "trawlarr: TRAWLARR_MODE=\"${TRAWLARR_MODE}\" must be \"server\" or \"node\"." >&2
  exit 78
fi
```

Check the image's actual CMD and CLI path in the `Dockerfile` and `docker/image-contract.test.ts` before writing this, and adjust the `set --` line to match exactly how the daemon is started today. Validate the mode before the rewrite.

**`compose.node.yml`:**
- A `trawlarr-node` service using the same image;
- `TRAWLARR_MODE=node`, `TRAWLARR_SERVER`, `TRAWLARR_NODE_TOKEN` (commented: "only needed the first time");
- `PUID`/`PGID`;
- a volume for `/config`, and the library bind mount at the node's own path;
- no `ports:`;
- plus a `trawlarr-node-nvidia` profile variant with the NVIDIA settings copied from `compose.nvidia.yml`.

**README.** A "Remote nodes" section:
- what a node is, and that it must be able to reach library files directly (for now);
- adding a node from Config → Nodes;
- the path map, with an example;
- what happens when a node disconnects: the job keeps running, and the file is released after the grace window (1 h default) and never installed afterwards;
- revoke;
- that plugins run on the node as its service user, unsandboxed, as on the server.

- [ ] **Step 1: Failing tests**:
  - `entrypoint.test.ts`: `TRAWLARR_MODE=node` with no args execs the node command; `TRAWLARR_MODE=bogus` exits 78; server mode is unchanged;
  - `compose-contract.test.ts`: `compose.node.yml` parses, uses the same image reference as `compose.yml`, publishes no ports, and sets `TRAWLARR_MODE=node`.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS)**

Run: `pnpm test -- docker && pnpm lint`

- [ ] **Step 3: Commit**

```bash
git add docker README.md
git commit -m "feat(docker): run the same image as a worker node with TRAWLARR_MODE=node and document remote nodes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Final verification

- [ ] **Step 1:** `pnpm build && pnpm typecheck && pnpm lint && pnpm check:refs`. All must be clean.
- [ ] **Step 2:** Run the server, core, engine, web and docker test directories separately. The full `pnpm test` stalls the dev machine, so run them in turn: `pnpm test -- packages/core`, `pnpm test -- packages/engine`, `pnpm test -- packages/server/src`, `pnpm test -- packages/server/test`, `pnpm test -- packages/web`, `pnpm test -- docker`. Record the pass/skip counts. Any skipped real-media suite must be explained by a missing binary (`ENOENT`), not ignored.
- [ ] **Step 3:** Re-read the spec's Error handling summary table and point to the test that proves each row. Add a test for any row without one.
- [ ] **Step 4:** Update `docs/engineering-notes/p2-prerequisites.md` with any deliberate divergence found during execution: e.g. `drain({ includeRemote: false })`, and the test-only seams added in Task 12.
- [ ] **Step 5:** Use superpowers:requesting-code-review on the branch, then superpowers:finishing-a-development-branch.
