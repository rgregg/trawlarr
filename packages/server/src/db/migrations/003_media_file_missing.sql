-- Reconciliation: a row whose file is no longer on disk.
--
-- Before this column the scanner only ever added and updated, so a deleted
-- file left its row behind forever: `media_file` grew monotonically, and
-- `countsByState` -- the input to the convergence percentage this product
-- exists to report -- counted rows corresponding to no file. A library of
-- one file could read "2 files, 100% converged", and a file deleted while
-- `queued`/`held`/`failed` left a row that could never reach `good`, so
-- that library could never read 100% again.
--
-- The column records WHEN the scanner first confirmed the file was gone,
-- and is NULL for every row whose file is present. Marking rather than
-- deleting is deliberate: the row carries the file's job history, attempt
-- counts and original size, all of which a user would want after an
-- accidental deletion, and a mark is reversible by simply putting the file
-- back (the next scan clears it) where a DELETE is not reversible at all.
-- Missing rows are excluded from `countsByState` (so the convergence
-- percentage describes only files that exist) and from `claimNext` (so a
-- file that vanished while queued is never handed to a worker).
ALTER TABLE media_file ADD COLUMN missing_since_ms INTEGER;

-- The two reads this column adds are both "which rows in this library are
-- (not) missing", alongside the state filter `countsByState` groups on.
CREATE INDEX media_file_missing_idx ON media_file (library_id, missing_since_ms);
