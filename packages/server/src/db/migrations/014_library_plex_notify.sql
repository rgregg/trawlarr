-- Per-library Plex notification. Deliberately NOT part of the flow definition:
-- the flow definition's hash is the convergence signature, so a token rotated
-- in a flow would mark every file in the library not-known-good and re-queue
-- the whole library. Two libraries also routinely share one flow, and they do
-- not share a Plex section.
ALTER TABLE library ADD COLUMN plex_url TEXT NOT NULL DEFAULT '';
ALTER TABLE library ADD COLUMN plex_token TEXT NOT NULL DEFAULT '';
ALTER TABLE library ADD COLUMN plex_section_id TEXT NOT NULL DEFAULT '';
-- Plex's own spelling of this library's root, when it differs from trawlarr's
-- (a bind mount usually makes it differ). Empty means "refresh the whole
-- section": always correct, merely coarser. A wrong prefix is worse than none,
-- because Plex answers 200 to a path it does not own and scans nothing.
ALTER TABLE library ADD COLUMN plex_path_prefix TEXT NOT NULL DEFAULT '';
