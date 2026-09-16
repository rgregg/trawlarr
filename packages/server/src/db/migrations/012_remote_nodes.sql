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
