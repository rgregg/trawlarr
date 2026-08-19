import type { HardwareType } from '@trawlarr/core';
import type { Db } from '../../db/connection.js';
import type { SettingsRepo } from '../../db/settings-repo.js';
import type { Route } from '../router.js';

/** The id the local node always has. v1 has exactly one node; v1.2 adds remote ones. */
export const LOCAL_NODE_ID = 'local';

interface NodeRow {
  id: string;
  name: string;
  access_mode: string;
  path_map_json: string;
  hardware_types_json: string;
  tags: string;
  last_seen_at: number | null;
}

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

export const nodeRoutes: Route[] = [
  {
    method: 'GET',
    path: '/nodes',
    // A LIST, with one entry, on purpose. v1 has one node; remote nodes
    // arrive in v1.2 and land here. A client written against an object would
    // have to be rewritten the day a second node exists — and this API is
    // the only interface the UI has, so that rewrite would be everybody's.
    handler: ({ ctx }) => {
      const rows = ctx.db.prepare(`SELECT * FROM node ORDER BY id`).all() as NodeRow[];
      const status = ctx.supervisor.status();
      const hardware = ctx.settings.getHardware();

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        // `direct` means this node reaches library files through its own
        // filesystem. It is DECLARED, never probed — as is the hardware.
        accessMode: row.access_mode,
        hardwareTypes: JSON.parse(row.hardware_types_json) as HardwareType[],
        caps: hardware.caps,
        pathMap: JSON.parse(row.path_map_json) as unknown[],
        tags: row.tags,
        lastSeenAt: row.last_seen_at,
        // The live half, joined on: which workers this node is running right
        // now, and what the schedule wants of it.
        local: row.id === LOCAL_NODE_ID,
        paused: row.id === LOCAL_NODE_ID ? status.paused : null,
        target: row.id === LOCAL_NODE_ID ? status.target : null,
        workers: row.id === LOCAL_NODE_ID ? status.workers : [],
      }));
    },
  },
];
