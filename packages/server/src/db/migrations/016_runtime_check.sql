-- Expected-versus-actual runtime check.
--
-- Per-library source and threshold. Deliberately NOT part of the flow
-- definition, for the reason 014 gives: the flow's hash is the convergence
-- signature, so an API key rotated there would re-queue the whole library.
-- 'radarr' / 'sonarr' / '' (empty: fall back to TMDB when a global key is set).
ALTER TABLE library ADD COLUMN runtime_source_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE library ADD COLUMN runtime_source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE library ADD COLUMN runtime_source_key TEXT NOT NULL DEFAULT '';
-- Flag when |actual - expected| > max(percent of expected, minutes).
ALTER TABLE library ADD COLUMN runtime_threshold_percent REAL NOT NULL DEFAULT 5;
ALTER TABLE library ADD COLUMN runtime_threshold_minutes REAL NOT NULL DEFAULT 3;

-- Per file. All NULL until a background lookup has run; a NULL expected
-- runtime after a lookup means "could not be found", which is never a
-- mismatch. `runtime_checked_at` records attempts, hit or miss, so a miss is
-- retried on a schedule instead of on every pass.
ALTER TABLE media_file ADD COLUMN expected_runtime_ms INTEGER;
ALTER TABLE media_file ADD COLUMN expected_runtime_source TEXT;
ALTER TABLE media_file ADD COLUMN runtime_checked_at INTEGER;
-- The length the person chose to Ignore. It replaces the expected runtime as
-- the baseline, so the file reappears only when its length changes again.
ALTER TABLE media_file ADD COLUMN accepted_duration_ms INTEGER;

CREATE INDEX media_file_runtime_checked_idx ON media_file (runtime_checked_at);
