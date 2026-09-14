import { PathMapError, ScheduleConfigError, type ScheduleConfig } from '@trawlarr/core';
import type { Db } from '../../db/connection.js';
import {
  createNodeRepo,
  NodeRepoError,
  type NodeRecord,
  type NodeRepo,
} from '../../db/node-repo.js';
import type { SettingsRepo } from '../../db/settings-repo.js';
import {
  ApiError,
  created,
  noContent,
  optionalBoolean,
  optionalString,
  requireString,
  type Route,
} from '../router.js';

/** The id the local node always has. v1 has exactly one node; v1.2 adds remote ones. */
export const LOCAL_NODE_ID = 'local';

/**
 * Write the local node's row.
 *
 * The `node` table has existed since the first migration and nothing has ever
 * written it, which has two consequences worth stating: `GET /nodes` would
 * report an empty list on a perfectly healthy daemon, and `job.node_id` — the
 * column that records WHERE a job ran — has been null on every job ever
 * recorded, so a job's origin cannot be reconstructed. Both are fixed by the
 * row existing.
 *
 * Called when the API context is built, so a daemon that has served a single
 * request has a node row. `last_seen_at` is stamped at that moment; it is a
 * fact about this process starting, not a liveness heartbeat, and nothing
 * reads it as one.
 */
export const ensureLocalNode = (input: {
  db: Db;
  settings: SettingsRepo;
  nowMs: () => number;
}): void => {
  const hardware = input.settings.getHardware();
  input.db
    .prepare(
      `INSERT INTO node (id, name, access_mode, path_map_json, hardware_types_json, tags, last_seen_at)
       VALUES (?, ?, 'direct', '[]', ?, '', ?)
       ON CONFLICT(id) DO UPDATE SET
         access_mode = excluded.access_mode,
         hardware_types_json = excluded.hardware_types_json,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(LOCAL_NODE_ID, LOCAL_NODE_ID, JSON.stringify(hardware.available), input.nowMs());
};

/**
 * `PUT /nodes/:id`'s fields are all optional; unknown keys are ignored.
 * `name`/`paused`/`tags` are type-checked here (400 on the wrong type,
 * same as every other route's body validation); `pathMap`/`schedule` are
 * left to `NodeRepo.update`'s own `validatePathMap`/`validateSchedule`,
 * which already produce a caller-facing message for a bad shape and would
 * otherwise be duplicated here.
 */
const asPatchBody = (
  body: unknown,
): { name?: string; pathMap?: unknown; schedule?: unknown; paused?: boolean; tags?: string } => {
  const raw = (body as Record<string, unknown> | null | undefined) ?? {};
  return {
    name: optionalString(body, 'name'),
    pathMap: raw.pathMap,
    schedule: raw.schedule as ScheduleConfig | undefined,
    paused: optionalBoolean(body, 'paused'),
    tags: optionalString(body, 'tags'),
  };
};

/**
 * The `node` resource every management route returns, camel-cased straight
 * off `NodeRecord` — everything a UI needs to show and edit a node, and
 * NEVER `secret_hash`/`enroll_token_hash`: `enrolled` says whether a secret
 * exists, without ever handing one back out.
 */
const toNodeResource = (record: NodeRecord) => ({
  id: record.id,
  name: record.name,
  accessMode: record.accessMode,
  pathMap: record.pathMap,
  hardwareTypes: record.hardwareTypes,
  hardwareCaps: record.hardwareCaps,
  tags: record.tags,
  lastSeenAt: record.lastSeenAt,
  schedule: record.schedule,
  paused: record.paused,
  buildVersion: record.buildVersion,
  libraries: record.libraries,
  revokedAt: record.revokedAt,
  enrolled: record.enrolled,
  enrollExpiresAt: record.enrollExpiresAt,
});

/**
 * The local id refuses enrollment, revocation and deletion: it is not a
 * remote node at all, and none of those operations mean anything applied to
 * the daemon serving the request.
 */
const requireNotLocal = (id: string): void => {
  if (id === LOCAL_NODE_ID) {
    throw new ApiError(
      400,
      'local-node',
      `"${LOCAL_NODE_ID}" is this daemon itself, not a remote node; it cannot be enrolled, ` +
        `revoked, or deleted.`,
    );
  }
};

const requireNode = (repo: NodeRepo, id: string): NodeRecord => {
  const record = repo.getById(id);
  if (record === null) throw new ApiError(404, 'node-not-found', `No node with id "${id}".`);
  return record;
};

/** Maps the three distinct error classes `NodeRepo` throws to a 400 with their own message. */
const asNodeApiError = (error: unknown): ApiError | null => {
  if (
    error instanceof NodeRepoError ||
    error instanceof PathMapError ||
    error instanceof ScheduleConfigError
  ) {
    return new ApiError(400, 'invalid-node', error.message);
  }
  return null;
};

export const nodeRoutes: Route[] = [
  {
    method: 'GET',
    path: '/nodes',
    // A LIST. v1 had exactly one entry; remote nodes land here as they
    // enroll. A client written against an object would have to be rewritten
    // the day a second node exists — and this API is the only interface the
    // UI has, so that rewrite would be everybody's.
    handler: ({ ctx }) => {
      const repo = createNodeRepo(ctx.db);
      const records = repo.list();
      const status = ctx.supervisor.status();
      const hardware = ctx.settings.getHardware();
      // Jobs currently running on each node, joined on here rather than
      // stored on the node row: a job's node assignment already lives in
      // `job.node_id`, and duplicating "is it running" onto `node` would be
      // one more place for the two to disagree.
      const runningRows = ctx.db
        .prepare(`SELECT id, node_id FROM job WHERE ended_at IS NULL AND node_id IS NOT NULL`)
        .all() as { id: string; node_id: string }[];
      const runningByNode = new Map<string, string[]>();
      for (const row of runningRows) {
        const jobs = runningByNode.get(row.node_id) ?? [];
        jobs.push(row.id);
        runningByNode.set(row.node_id, jobs);
      }

      return records.map((record) => {
        const local = record.id === LOCAL_NODE_ID;
        return {
          ...toNodeResource(record),
          // `direct` means this node reaches library files through its own
          // filesystem. It is DECLARED, never probed — as is the hardware.
          caps: hardware.caps,
          // The live half, joined on: which workers this node is running
          // right now, whether it is reachable at all, and what the
          // schedule wants of it. The local node's own shape here is
          // unchanged from before remote nodes existed — `paused`/`target`/
          // `workers` still come straight off the supervisor, not the row.
          local,
          paused: local ? status.paused : record.paused,
          target: local ? status.target : null,
          workers: local ? status.workers : [],
          online: local ? true : ctx.nodes.isOnline(record.id),
          running: runningByNode.get(record.id) ?? [],
        };
      });
    },
  },

  {
    method: 'POST',
    path: '/nodes',
    handler: async ({ body, ctx }) => {
      const name = requireString(body, 'name');
      try {
        const { node, enrollToken } = await createNodeRepo(ctx.db).create({
          name,
          nowMs: ctx.nowMs(),
        });
        return created({
          node: toNodeResource(node),
          enrollToken,
          enrollExpiresAt: node.enrollExpiresAt,
        });
      } catch (error) {
        const mapped = asNodeApiError(error);
        if (mapped !== null) throw mapped;
        throw error;
      }
    },
  },

  {
    method: 'POST',
    path: '/nodes/:id/enroll-token',
    handler: async ({ params, ctx }) => {
      const id = params.id!;
      requireNotLocal(id);
      const repo = createNodeRepo(ctx.db);
      const record = requireNode(repo, id);
      if (record.enrolled) {
        throw new ApiError(
          409,
          'already-enrolled',
          `Node "${id}" is already enrolled and has a secret; a new enrollment token would ` +
            `never match it (enrollment only ever targets a node with no secret yet). Delete ` +
            `this node and create a new one to issue it a fresh enrollment token.`,
        );
      }
      const { enrollToken, expiresAt } = await repo.regenerateEnrollToken({
        id,
        nowMs: ctx.nowMs(),
      });
      return { enrollToken, enrollExpiresAt: expiresAt };
    },
  },

  {
    method: 'PUT',
    path: '/nodes/:id',
    handler: ({ params, body, ctx }) => {
      const id = params.id!;
      const repo = createNodeRepo(ctx.db);
      requireNode(repo, id);
      const patch = asPatchBody(body);
      try {
        const updated = repo.update(id, {
          name: patch.name,
          pathMap: patch.pathMap,
          // Validated (or rejected) by `NodeRepo.update` itself via
          // `validateSchedule` — this cast is just shape, not a claim of
          // safety.
          schedule: patch.schedule as ScheduleConfig | undefined,
          paused: patch.paused,
          tags: patch.tags,
        });
        ctx.nodes.pushConfig(id);
        return toNodeResource(updated);
      } catch (error) {
        const mapped = asNodeApiError(error);
        if (mapped !== null) throw mapped;
        throw error;
      }
    },
  },

  {
    method: 'POST',
    path: '/nodes/:id/revoke',
    handler: ({ params, ctx }) => {
      const id = params.id!;
      requireNotLocal(id);
      const repo = createNodeRepo(ctx.db);
      requireNode(repo, id);
      repo.revoke(id, ctx.nowMs());
      ctx.nodes.disconnect(id, 'revoked');
      return toNodeResource(requireNode(repo, id));
    },
  },

  {
    method: 'DELETE',
    path: '/nodes/:id',
    handler: ({ params, ctx }) => {
      const id = params.id!;
      requireNotLocal(id);
      const repo = createNodeRepo(ctx.db);
      requireNode(repo, id);
      try {
        repo.remove(id);
      } catch (error) {
        if (error instanceof NodeRepoError) throw new ApiError(409, 'node-busy', error.message);
        throw error;
      }
      return noContent();
    },
  },
];
