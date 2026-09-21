import { dirname, sep } from 'node:path';
import { pathContains } from '../fs/path-contains.js';

/**
 * What one library needs in order to tell Plex that something under it
 * changed. All four fields are per-library on purpose: two libraries
 * routinely share one flow (they do in the deployment this was written
 * for), so the section a refresh names cannot live in the flow definition —
 * and a token there would be worse still, because the flow definition's hash
 * IS the convergence signature, so rotating a Plex token would mark every
 * file in the library not-known-good and re-queue the lot.
 */
export interface PlexConfig {
  /** Origin of the Plex server, e.g. `http://plex.lan:32400`. Empty disables notification. */
  url: string;
  token: string;
  /** Plex's own numeric id for the library section, as it appears in `/library/sections`. */
  sectionId: string;
  /**
   * The prefix Plex uses for this library's root, when it differs from
   * trawlarr's. Null (or empty) means "do not try to scope a refresh" — the
   * whole section is refreshed instead, which is always correct and merely
   * coarser. A WRONG prefix is worse than none: Plex accepts a `path` it does
   * not own and quietly scans nothing.
   *
   * Only honoured for a SINGLE-ROOT library; see `plexRefreshPath`.
   */
  pathPrefix: string | null;
}

export type PlexFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number }>;

export interface PlexNotifier {
  /**
   * Record that the library file at `path` was replaced. Returns immediately;
   * the refresh is sent once the coalescing window closes.
   */
  fileReplaced: (input: {
    libraryId: string;
    config: PlexConfig;
    roots: string[];
    path: string;
  }) => void;
  /** Drop any pending window. Sending after shutdown is worse than not sending. */
  stop: () => void;
}

/** How long replacements are gathered before a refresh is sent. */
const DEFAULT_WINDOW_MS = 10_000;

/**
 * Distinct directories above which one section-wide refresh is cheaper than
 * naming them all. Plex re-walks the section either way; past this many
 * requests we are just adding round trips.
 */
const DEFAULT_MAX_PATHS = 20;

/**
 * The directory to refresh, in PLEX'S spelling, or null when it cannot be
 * derived — in which case the caller refreshes the whole section.
 *
 * Null rather than a guess is the important half. Plex answers 200 to a
 * `path` outside the section and scans nothing, so a mapping this cannot
 * justify would produce a notification that looks successful in every log and
 * silently never updates anything.
 */
export const plexRefreshPath = (input: {
  roots: string[];
  pathPrefix: string | null;
  filePath: string;
}): string | null => {
  const prefix = input.pathPrefix?.trim();
  if (prefix === undefined || prefix === '') return null;

  // ONE prefix cannot describe TWO roots. `/library/movies` and
  // `/library/movies-4k` are separate Plex locations (a real section can hold
  // several), so rewriting whichever root matched onto a single prefix would
  // name a directory under the wrong one — and Plex answers 200 and scans
  // nothing. A whole-section refresh is coarser and correct.
  if (input.roots.length !== 1) return null;

  // `pathContains` is the repo's own containment test: it compares on
  // separator boundaries, so "/library/show" does not contain
  // "/library/shows-archive/x.mkv". A bare `startsWith` here would map a
  // sibling directory into the wrong section.
  const root = input.roots.find((candidate) => pathContains(candidate, input.filePath));
  if (root === undefined) return null;

  const directory = dirname(input.filePath);
  const relative = directory.slice(root.replace(/\/+$/, '').length);
  return `${prefix.replace(/\/+$/, '')}${relative}`.split(sep).join('/');
};

const refreshUrl = (config: PlexConfig, path: string | null): string => {
  const base = `${config.url.replace(/\/+$/, '')}/library/sections/${encodeURIComponent(config.sectionId)}/refresh`;
  return path === null ? base : `${base}?path=${encodeURIComponent(path)}`;
};

interface Window {
  config: PlexConfig;
  /** Null once anything in this window could not be scoped: the section wins. */
  paths: Set<string> | null;
}

/**
 * Tells Plex to re-read what trawlarr just changed.
 *
 * Two things make this worth having over the community `Send Web Request`
 * node, which can already send a Plex refresh:
 *
 *  1. It fires from the fact that the LIBRARY FILE CHANGED — the identity
 *     comparison in `apply-report.ts` — not from a node's position in a flow.
 *     A flow node fires once per file whether or not anything was replaced,
 *     so a converged library still sends one request per file per pass.
 *  2. It can scope the refresh to the directory that changed, because it runs
 *     where the installed path is known. A flow node's inputs are literal
 *     strings; trawlarr does not expand `{{...}}` into third-party plugin
 *     inputs, so a community node can only ever refresh a whole section.
 *
 * Nothing here is allowed to fail a job. Every request is fire-and-forget and
 * every error is reported through `onError`: the file on disk is converged
 * whether or not Plex heard about it, and a media server that is down must
 * not turn a finished transcode into a failure.
 */
export const createPlexNotifier = (input: {
  fetchImpl: PlexFetch;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onError: (message: string) => void;
  windowMs?: number;
  maxPaths?: number;
}): PlexNotifier => {
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const maxPaths = input.maxPaths ?? DEFAULT_MAX_PATHS;
  const windows = new Map<string, Window>();
  let handle: unknown = null;
  let stopped = false;

  const send = async (config: PlexConfig, path: string | null): Promise<void> => {
    const url = refreshUrl(config, path);
    // The token rides in a header, never the query string: the query string
    // is what ends up in a reverse proxy's access log.
    let response: { ok: boolean; status: number };
    try {
      response = await input.fetchImpl(url, {
        method: 'GET',
        headers: { 'X-Plex-Token': config.token, Accept: 'application/json' },
      });
    } catch (error) {
      input.onError(
        `Plex refresh failed for section ${config.sectionId}: ${error instanceof Error ? error.message : String(error)}. ` +
          `The file is installed and converged; only Plex's view of it is stale.`,
      );
      return;
    }
    if (!response.ok) {
      input.onError(
        `Plex refused a refresh for section ${config.sectionId}: HTTP ${response.status}. ` +
          `Check the library's Plex token and section id. The file itself is installed and converged.`,
      );
    }
  };

  const flush = (): void => {
    handle = null;
    const due = [...windows.values()];
    windows.clear();
    for (const window of due) {
      // A window too wide to name is one request, not hundreds.
      const paths =
        window.paths === null || window.paths.size > maxPaths ? null : [...window.paths];
      if (paths === null) {
        void send(window.config, null);
        continue;
      }
      for (const path of paths) void send(window.config, path);
    }
  };

  return {
    fileReplaced: ({ libraryId, config, roots, path }) => {
      if (stopped) return;
      // An unconfigured library is the normal case, not an error: notification
      // is opt-in, and Plex's own filesystem watching already covers the
      // deployments where the library is a local path Plex can watch.
      if (config.url.trim() === '' || config.sectionId.trim() === '') return;

      const scoped = plexRefreshPath({ roots, pathPrefix: config.pathPrefix, filePath: path });
      const existing = windows.get(libraryId);
      if (existing === undefined) {
        windows.set(libraryId, { config, paths: scoped === null ? null : new Set([scoped]) });
      } else if (existing.paths !== null) {
        if (scoped === null) existing.paths = null;
        else existing.paths.add(scoped);
      }

      if (handle === null) handle = input.setTimer(flush, windowMs);
    },
    stop: () => {
      stopped = true;
      windows.clear();
      if (handle !== null) input.clearTimer(handle);
      handle = null;
    },
  };
};
