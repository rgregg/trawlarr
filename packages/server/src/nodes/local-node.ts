import type { Db } from '../db/connection.js';
import type { SettingsRepo } from '../db/settings-repo.js';

/**
 * The id the local node always has.
 *
 * Its own module so the supervisor and the stall reaper can name it without
 * importing an API route file.
 */
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
 * Called when the API context is built, and when a supervisor is built: every
 * job the supervisor starts records `node_id`, a foreign key to this row, so
 * a supervisor built without an API context (`two-workers.test.ts`) would
 * otherwise fail its very first claim. Idempotent. `last_seen_at` is stamped
 * at that moment; it is a fact about this process starting, not a liveness
 * heartbeat, and nothing reads it as one.
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
