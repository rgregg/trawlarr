-- A node declares a SET of hardware types, not one.
--
-- `hardware.available` in settings has always been a list (a host with an
-- NVENC card still runs CPU work), and the supervisor's eligibility check
-- reads it as a list. The `node` table's single `hardware_type` column could
-- only ever record one of them, so a node row was guaranteed to disagree with
-- the settings it was built from the moment a second type was declared — and
-- `GET /nodes` reads that row. Nothing has ever written this table, so the
-- backfill below is over zero rows in every existing database; it is written
-- anyway so that a database which somehow does hold a row keeps its value.
ALTER TABLE node ADD COLUMN hardware_types_json TEXT NOT NULL DEFAULT '["cpu"]';

UPDATE node SET hardware_types_json = json_array(hardware_type);

ALTER TABLE node DROP COLUMN hardware_type;
