-- WHEN AN OPERATOR ASKED TO CANCEL A JOB, durably.
--
-- A local cancel reaches its worker at once, so it never needed a column. A
-- remote node can be offline when the cancel is made, and a cancel held only
-- in the daemon's memory is forgotten by a daemon restart: the node then
-- reconnects, its lease is still valid, and its commit is GRANTED for a job
-- the operator cancelled. Recording the request here lets the commit gate
-- refuse it and lets an adopted job re-send the cancel on reconnect.
ALTER TABLE job ADD COLUMN cancel_requested_at INTEGER;
