import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Reads the `{ "version": ... }` document `scripts/stamp-version.mjs` writes.
 * `null` for anything else, so a missing or damaged stamp is one outcome.
 */
export const versionFrom = (raw: string | null): string | null => {
  if (raw === null) return null;
  try {
    const { version } = JSON.parse(raw) as { version?: unknown };
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
};

const readStamp = (): string | null => {
  try {
    return readFileSync(fileURLToPath(new URL('../version.json', import.meta.url)), 'utf8');
  } catch {
    return null;
  }
};

/**
 * The version this build reports through `GET /system/version`. It comes from
 * the git tag (`git describe`, or `TRAWLARR_VERSION` in the image build, which
 * has no `.git`), stamped into `dist/version.json` at build time; nothing in
 * the tree states a release number, so a tag and a version cannot disagree.
 * `dev` when unstamped (tests, running from `src/`), never a number that could
 * pass for a release.
 *
 * Its own module, with no imports of the daemon, because a remote node reports
 * it in its `hello` and the node host may not reach `daemon.ts` — which opens
 * the database — through its import graph (see the module-graph guard in
 * `worker/agent-handle.test.ts`).
 */
export const DAEMON_VERSION = versionFrom(readStamp()) ?? 'dev';
