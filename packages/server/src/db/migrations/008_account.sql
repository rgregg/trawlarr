-- A LOGGED-IN OPERATOR, distinct from the daemon's single shared API key.
--
-- `daemon.apiKey` (see the `setting` table) authenticates a MACHINE — a
-- worker, the CLI, an agent — with no notion of who is behind it. This table
-- authenticates a PERSON, so that a browser can sign in with a name and a
-- password, or via an OIDC provider such as Authentik, and so that the audit
-- trail on a login says who, not just "the shared secret was presented".
--
-- Every account has full ("admin") access; there are no roles yet, matching
-- the daemon's existing single-tier permission model — an account is
-- authenticated, not authorised into a subset. That is a decision that can be
-- narrowed later without a schema change, but never widened without one, so
-- narrowing is the direction left open.
--
-- `password_hash` and `(oidc_issuer, oidc_subject)` are BOTH nullable, and
-- exactly one style of login populates one or the other: a password-only
-- account has no OIDC identity, and a JIT-provisioned OIDC account is never
-- given a local password (there is nothing safe to compare it against). An
-- account is never required to have both, and the login handlers each check
-- only the column their flow uses.
CREATE TABLE account (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,
  display_name TEXT,
  -- The issuer URL, not just the subject: a subject id is only unique WITHIN
  -- one issuer, and two different providers are free to hand out the same
  -- subject string to unrelated humans.
  oidc_issuer TEXT,
  oidc_subject TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE UNIQUE INDEX account_oidc_identity_idx ON account (oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;
