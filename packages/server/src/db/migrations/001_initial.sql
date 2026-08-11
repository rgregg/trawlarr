CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE library (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  roots_json            TEXT NOT NULL DEFAULT '[]',
  extensions_json       TEXT NOT NULL DEFAULT '[]',
  companion_extensions_json TEXT NOT NULL DEFAULT '[]',
  staging_dir           TEXT,
  trash_dir             TEXT,
  flow_id               TEXT REFERENCES flow(id) ON DELETE SET NULL,
  allow_hardlinked      INTEGER NOT NULL DEFAULT 0,
  enabled               INTEGER NOT NULL DEFAULT 1,
  paused_reason         TEXT,
  user_variables_json   TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL
);

CREATE TABLE flow (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE plugin_source (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_synced_at INTEGER
);

CREATE TABLE plugin (
  id           TEXT PRIMARY KEY,
  source_id    TEXT REFERENCES plugin_source(id) ON DELETE CASCADE,
  rel_path     TEXT NOT NULL,
  abs_path     TEXT NOT NULL,
  version      TEXT NOT NULL,
  details_json TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source_id, rel_path)
);

CREATE TABLE media_file (
  id                     TEXT PRIMARY KEY,
  library_id             TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,

  -- Identity. Path is an attribute, never the key (spec 4.2).
  inode_key              TEXT,
  content_key            TEXT NOT NULL,
  path                   TEXT NOT NULL,
  nlink                  INTEGER NOT NULL DEFAULT 1,

  size_bytes             INTEGER NOT NULL,
  mtime_ms               INTEGER NOT NULL,
  ctime_ms               INTEGER NOT NULL,
  container              TEXT NOT NULL DEFAULT '',

  probe_json             TEXT,
  exiftool_json          TEXT,
  mediainfo_json         TEXT,

  -- Denormalised for fast filtering without parsing probe_json.
  video_codec            TEXT,
  audio_codec            TEXT,
  resolution             TEXT,
  duration_ms            INTEGER,
  bitrate                INTEGER,

  -- Ledger (spec 5.3).
  state                  TEXT NOT NULL DEFAULT 'unknown',
  signature              TEXT,
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  consecutive_noop_count INTEGER NOT NULL DEFAULT 0,
  hold_until_ms          INTEGER,
  pre_facts_json         TEXT,
  post_facts_json        TEXT,
  original_size_bytes    INTEGER,
  last_run_id            TEXT,

  priority               INTEGER NOT NULL DEFAULT 0,
  discovered_at          INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,

  UNIQUE (library_id, content_key)
);

CREATE INDEX media_file_inode_idx   ON media_file (library_id, inode_key);
CREATE INDEX media_file_path_idx    ON media_file (library_id, path);
CREATE INDEX media_file_queue_idx   ON media_file (state, hold_until_ms, priority, discovered_at);
CREATE INDEX media_file_codec_idx   ON media_file (library_id, video_codec);

CREATE TABLE node (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  access_mode    TEXT NOT NULL DEFAULT 'direct',
  path_map_json  TEXT NOT NULL DEFAULT '[]',
  hardware_type  TEXT NOT NULL DEFAULT 'cpu',
  tags           TEXT NOT NULL DEFAULT '',
  last_seen_at   INTEGER
);

CREATE TABLE job (
  id            TEXT PRIMARY KEY,
  file_id       TEXT NOT NULL REFERENCES media_file(id) ON DELETE CASCADE,
  flow_id       TEXT NOT NULL,
  flow_hash     TEXT NOT NULL,
  node_id       TEXT REFERENCES node(id) ON DELETE SET NULL,
  worker_class  TEXT NOT NULL DEFAULT 'transcode',
  state         TEXT NOT NULL,
  outcome       TEXT,
  log_path      TEXT,
  started_at    INTEGER NOT NULL,
  heartbeat_at  INTEGER,
  ended_at      INTEGER
);

CREATE INDEX job_file_idx ON job (file_id, started_at DESC);

CREATE TABLE job_step (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  node_id        TEXT NOT NULL,
  plugin_id      TEXT NOT NULL,
  output_number  INTEGER,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  log_excerpt    TEXT NOT NULL DEFAULT '',
  UNIQUE (job_id, seq)
);

-- Backs deps.crudTransDBN for plugin-owned collections (spec 2.9).
CREATE TABLE plugin_document (
  collection TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, doc_id)
);
