-- OPEN JOBS BY NODE.
--
-- Removing a node first asks whether it still has a job that has not ended
-- (`SELECT id FROM job WHERE node_id = ? AND ended_at IS NULL`). With no index
-- that walks the whole job table, which only grows. Partial for the same
-- reason `job_leased_idx` is: only unended rows of remote jobs are ever asked
-- about, and those are a handful however long the history gets.
CREATE INDEX job_node_open_idx ON job (node_id) WHERE ended_at IS NULL AND node_id IS NOT NULL;
