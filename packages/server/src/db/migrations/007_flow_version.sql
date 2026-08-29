-- WHAT A FLOW ACTUALLY LOOKED LIKE, at every point in time it ran a job.
--
-- Publishing a flow overwrites `flow.definition_json` in place and re-queues
-- every file in every library that uses it -- 5,194 of them on the largest
-- install known to run this. The graph that produced yesterday's output is
-- gone the moment a new one is published over it; there has never been a way
-- to look at what changed, or to get the old graph back.
--
-- Meanwhile `job.flow_hash` has recorded, since job one, exactly which
-- definition ran -- roughly 5,500 rows of it -- while nothing has ever stored
-- what a given hash actually was. The hash has been a receipt for a document
-- nobody kept.
--
-- `flow_version` is that document store: one row per publish, oldest first,
-- never overwritten. `flow` still holds the live, editable definition for
-- day-to-day use; this table is the append-only history behind it, tied to
-- the owning flow with ON DELETE CASCADE so deleting a flow doesn't leave its
-- history behind as orphaned rows.
--
-- `definition_hash` is deliberately NOT unique here. Publishing A, then B,
-- then A again yields three rows, and the first and third share a hash --
-- that repetition is the point: it is the record that a change was reverted.
-- A unique index on this column would collapse that history and silently
-- destroy the very thing this table exists to keep. Do not add one.
CREATE TABLE flow_version (
  id               TEXT PRIMARY KEY,
  flow_id          TEXT NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
  definition_hash  TEXT NOT NULL,
  definition_json  TEXT NOT NULL,
  note             TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL
);

CREATE INDEX flow_version_flow_idx ON flow_version (flow_id, created_at DESC);
CREATE INDEX flow_version_hash_idx ON flow_version (definition_hash);

-- Backfill: every flow that already exists gets its current definition
-- recorded as its first version, so the history starts complete rather than
-- with a gap for everything published before this migration existed.
--
-- `randomUUID()` is not available in SQL, so the id is assembled from
-- randomblob to the same v4 shape the application generates elsewhere --
-- an id that looks different from every other id in the schema would be a
-- lasting puzzle for the sake of one migration.
INSERT INTO flow_version (id, flow_id, definition_hash, definition_json, note, created_at)
SELECT
  lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
  ),
  id,
  definition_hash,
  definition_json,
  'Recorded when versioning was added',
  updated_at
FROM flow;
