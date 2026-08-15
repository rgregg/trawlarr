-- `flow.name` had no uniqueness constraint even though every lookup that
-- matters (the CLI's `flow add`/`library set-flow`, and any future API) is
-- by name: without this, two flows could share a name and `getByName` would
-- return one of them arbitrarily, silently pointing a library at the wrong
-- flow. A UNIQUE index makes that ambiguity impossible to create in the
-- first place, mirroring the constraint `library.name` already has.
--
-- A database created before this migration can already contain duplicate
-- flow names, and the UNIQUE index below would otherwise refuse to be
-- created at all -- bricking every later command with a raw constraint
-- failure and no recovery path (there is no `flow rename`/`flow rm`). So
-- every name but the OLDEST row wearing it is deterministically renamed
-- first, `" (2)"`, `" (3)"`, ... in creation order, exactly the scheme a
-- human resolving the collision by hand would reach for. This runs
-- unconditionally; on a database with no duplicates it touches zero rows.
UPDATE flow
SET name = name || ' (' || dup.n || ')'
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at, id) AS n
  FROM flow
) AS dup
WHERE flow.id = dup.id AND dup.n > 1;

CREATE UNIQUE INDEX flow_name_idx ON flow (name);
