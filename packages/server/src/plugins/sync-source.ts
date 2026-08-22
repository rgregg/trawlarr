import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createPluginLoader } from '@trawlarr/engine';
import { materialiseSource } from './fetch-source.js';
import type { DiscoveredPlugin, PluginRepo } from './plugin-repo.js';

export interface SyncReport {
  sourceId: string;
  installed: number;
  skipped: { relPath: string; reason: string }[];
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Directories a plugin tree never keeps plugins in, and which are large
 * enough that walking them is the difference between a sync taking a second
 * and taking a minute.
 */
const PRUNED = new Set(['node_modules', '.git', '.github', 'dist', 'coverage']);

const compareVersions = (a: string, b: string): number => {
  const left = VERSION_PATTERN.exec(a)!;
  const right = VERSION_PATTERN.exec(b)!;
  for (let i = 1; i <= 3; i += 1) {
    // Numeric per component, not lexicographic: a string comparison ranks
    // "1.9.0" above "1.10.0" and silently installs the older plugin.
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  return 0;
};

export interface DiscoveredCandidate {
  pluginName: string;
  version: string;
  relPath: string;
  absPath: string;
}

/**
 * A flow plugin is an `index.js` at `<pluginName>/<version>/index.js`.
 *
 * Stated as a rule rather than a hardcoded `FlowPlugins/CommunityFlowPlugins`
 * prefix so a source that is not Tdarr's repository works too — and because a
 * hardcoded prefix silently finds nothing when upstream reorganises, which
 * looks exactly like an empty repository.
 *
 * Classic plugins are excluded for free: they are bare `Tdarr_Plugin_*.js`
 * files, not versioned `index.js`, and trawlarr does not run them (spec 2.8).
 */
export const discoverFlowPlugins = (root: string): DiscoveredCandidate[] => {
  const best = new Map<string, DiscoveredCandidate>();

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!PRUNED.has(entry.name)) walk(abs);
        continue;
      }
      // Only a real file, never a symlink: a source tree is allowed to
      // contain links, and following one would walk out of the tree (or in a
      // loop) and load code from wherever it points.
      if (!entry.isFile()) continue;
      if (entry.name !== 'index.js') continue;

      const rel = relative(root, abs);
      const parts = rel.split(sep);
      // .../<pluginName>/<version>/index.js — three components at minimum,
      // or there is no plugin name to read and the candidate would install
      // itself under the name "undefined".
      if (parts.length < 3) continue;
      const version = parts[parts.length - 2]!;
      const pluginName = parts[parts.length - 3]!;
      if (!VERSION_PATTERN.test(version)) continue;

      const candidate: DiscoveredCandidate = {
        pluginName,
        version,
        relPath: parts.join('/'),
        absPath: abs,
      };
      const existing = best.get(pluginName);
      if (existing === undefined || compareVersions(version, existing.version) > 0) {
        best.set(pluginName, candidate);
      }
    }
  };

  walk(root);
  return [...best.values()].sort((a, b) => (a.pluginName < b.pluginName ? -1 : 1));
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Delete every extraction under this source's slot except the one just
 * installed from.
 *
 * A tarball source's `absPath` points INTO the extracted copy, so that copy
 * has to outlive the sync — which means the previous sync's copy is what has
 * to go, and only once the new rows are written. Left alone, every sync of
 * a tarball source would leave another whole tree behind in the data
 * directory forever.
 */
const pruneOldExtractions = (slotDir: string, keep: string): void => {
  let entries;
  try {
    entries = readdirSync(slotDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(slotDir, entry.name);
    if (abs === keep) continue;
    rmSync(abs, { recursive: true, force: true });
  }
};

export const syncSource = async (input: {
  repo: PluginRepo;
  sourceId: string;
  cacheDir: string;
  nowMs: () => number;
  fetchFn?: typeof fetch;
  /**
   * Awaited between candidate plugins.
   *
   * Loading a plugin is synchronous — it runs the module body — and a real
   * source is ninety of them, so a sync inside the DAEMON would otherwise
   * hold the event loop for the whole validation pass and stall the API, the
   * websocket and the supervisor tick behind it. The daemon passes a
   * `setImmediate` turn here; the CLI, which has nothing else to serve,
   * passes nothing and keeps the tight loop.
   */
  yieldFn?: () => Promise<void>;
}): Promise<SyncReport> => {
  const source = input.repo.getSource(input.sourceId);
  if (source === null) {
    throw new Error(`No plugin source "${input.sourceId}". Add it before syncing.`);
  }

  // One slot per source, so pruning the previous extraction below cannot
  // reach another source's. The id is a validated slug — lowercase letters,
  // digits and hyphens — so it is a single safe path component.
  const slotDir = join(input.cacheDir, input.sourceId);

  const materialised = await materialiseSource({
    kind: source.kind,
    url: source.url,
    cacheDir: slotDir,
    fetchFn: input.fetchFn,
  });

  let written = false;
  try {
    // A loader private to this sync, so nothing a plugin left in a module
    // cache during validation is visible to a job later, and so the cache
    // this fills with every plugin in the source is discarded with it.
    const loader = createPluginLoader();
    const installed: DiscoveredPlugin[] = [];
    const skipped: { relPath: string; reason: string }[] = [];

    for (const candidate of discoverFlowPlugins(materialised.dir)) {
      if (input.yieldFn !== undefined) await input.yieldFn();
      try {
        // Loading is the validation. It runs the module body, which is what
        // `details()` costs, and it is the same thing the executor will do —
        // so a plugin that installs is a plugin that runs. Installing a row
        // we never loaded means a flow validates and then fails on the first
        // file, with an error naming a file rather than a plugin.
        //
        // Be clear about what this is: installing a plugin RUNS ITS AUTHOR'S
        // CODE as the service user, at install time rather than at job time.
        // That is the documented, accepted cost of running third-party
        // plugins at all, and this does not widen it — nothing here executes
        // `plugin()`, which is the half that touches files and spawns ffmpeg.
        // Only the module body and `details()` run, and only for files the
        // archive checks in `fetch-source` already accepted.
        // The loader itself refuses a module that does not export both
        // `details()` and `plugin()` as functions, and refuses `details()`
        // that does not return an `outputs` ARRAY, so neither check is
        // repeated here.
        //
        // What is deliberately NOT checked is how many outputs that array
        // has. Zero is a legal, meaningful declaration: it says the node is
        // TERMINAL — nothing routes out of it. Upstream ships three such
        // plugins (failFlow, which fails the run on purpose, and two
        // versions of goToFlow), and for them `outputs: []` is the accurate
        // description of the node, not a defect in it. Rejecting them here
        // made trawlarr wrong about the contract and silently dropped
        // working community plugins from every sync of the real corpus.
        // Flow validation still refuses to let an EDGE leave a terminal
        // node — see `edge-from-terminal-node` in `flow-validate` — which is
        // where "nothing routes out of it" belongs.
        const loaded = loader.load(candidate.absPath);
        installed.push({
          pluginName: candidate.pluginName,
          relPath: candidate.relPath,
          absPath: candidate.absPath,
          version: candidate.version,
          details: loaded.details,
        });
      } catch (error) {
        skipped.push({ relPath: candidate.relPath, reason: messageOf(error) });
      }
    }

    input.repo.replaceSourcePlugins(input.sourceId, installed);
    input.repo.markSynced(input.sourceId, input.nowMs());
    written = true;

    return { sourceId: input.sourceId, installed: installed.length, skipped };
  } finally {
    // Note the asymmetry, and do not tidy it. A LOCAL source's cleanup is a
    // no-op, so this cannot delete a user's tree; a TARBALL source's
    // extracted copy is what `absPath` points at, so it must survive — it IS
    // the installed plugin. It lives under the cache directory, inside the
    // data directory, and the previous one is dropped once the new rows are
    // written rather than before, so a fetch that fails leaves what is
    // installed still on disk.
    if (source.kind !== 'tarball' || !written) {
      materialised.cleanup();
    } else {
      pruneOldExtractions(slotDir, dirname(materialised.dir));
    }
  }
};
