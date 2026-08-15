-- `flow.name` had no uniqueness constraint even though every lookup that
-- matters (the CLI's `flow add`/`library set-flow`, and any future API) is
-- by name: without this, two flows could share a name and `getByName` would
-- return one of them arbitrarily, silently pointing a library at the wrong
-- flow. A UNIQUE index makes that ambiguity impossible to create in the
-- first place, mirroring the constraint `library.name` already has.
CREATE UNIQUE INDEX flow_name_idx ON flow (name);
