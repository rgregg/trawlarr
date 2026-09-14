import { createHash } from 'node:crypto';
import { readdirSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Describes an installed plugin source tree as a content-addressed bundle,
 * so a remote node can be shipped exactly the code the server resolved a
 * plugin id against (Task 8), rather than trusting whatever happens to be
 * on the node's own disk under that name.
 *
 * MUST NOT import anything under `../db/`, or anything that transitively
 * does: the node host (Task 8+) imports `bundleHash` from here, and it has
 * no database — a module-graph test enforces the boundary the same way
 * `node-frames.ts` documents for itself.
 *
 * Community flow plugins `require('../../../../FlowHelpers/…')` out of
 * their own directory, which is why the unit shipped is the WHOLE source
 * tree a plugin was discovered under, never the plugin's own directory.
 */

export interface BundleFile {
  relPath: string;
  sha256: string;
  sizeBytes: number;
}

export interface BundleManifest {
  files: BundleFile[];
}

export class BundleLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleLimitError';
  }
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Byte-order comparison, not `localeCompare`: the manifest's canonical form
 * has to be identical on every host regardless of locale, and a locale-aware
 * sort can reorder strings differently between two otherwise-identical
 * builds of the same code.
 */
const compareRelPath = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * sha256 hex of `JSON.stringify(manifest)`, with each file's keys in the
 * exact order `relPath, sha256, sizeBytes` and files sorted by relPath —
 * canonical, so two builds of the same tree hash identically and the hash
 * can be trusted as a cache key across processes.
 */
export const bundleHash = (manifest: BundleManifest): string => {
  const canonical: BundleManifest = {
    files: manifest.files.map((file) => ({
      relPath: file.relPath,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};

interface WalkedFile {
  absPath: string;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Lists the regular files under `root`, cheaply (lstat only, no content
 * read) — this is the pass `manifestFor` uses to decide whether its cache
 * is still good before paying for a full sha256 of every file.
 *
 * `lstat`, not `stat`: a symlink is skipped rather than followed, because a
 * source tree is allowed to contain one and following it would walk out of
 * the tree (or in a circle) and ship code from wherever it points. `.git`
 * is excluded at any depth — it is never part of a plugin tree and can be
 * large enough on its own to blow the file/byte limits for no benefit.
 */
const walkTree = (root: string, limits: { maxFiles: number; maxBytes: number }): WalkedFile[] => {
  const files: WalkedFile[] = [];
  let totalBytes = 0;

  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (entry.name === '.git') continue;
        visit(abs);
        continue;
      }
      if (!stat.isFile()) continue;

      if (files.length >= limits.maxFiles) {
        throw new BundleLimitError(
          `Bundle tree at "${root}" has more than maxFiles (${limits.maxFiles}) files.`,
        );
      }
      totalBytes += stat.size;
      if (totalBytes > limits.maxBytes) {
        throw new BundleLimitError(
          `Bundle tree at "${root}" exceeds maxBytes (${limits.maxBytes}).`,
        );
      }

      const relPath = relative(root, abs).split(sep).join('/');
      files.push({ absPath: abs, relPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  };

  visit(root);
  return files;
};

export interface BundleStore {
  /**
   * Manifest for the tree at `root`, cached by (root, max mtime of its
   * files). A sync that overwrites a file bumps that file's mtime, which is
   * what invalidates the cache — nothing here watches the filesystem.
   */
  manifestFor(root: string): Promise<{ hash: string; manifest: BundleManifest }>;
  /** The root registered under `hash` by a prior `manifestFor` call, or null. */
  rootFor(hash: string): string | null;
  /**
   * Absolute path of `relPath` inside the bundle `hash`, or null when it is
   * not listed in that bundle's manifest.
   *
   * This IS the containment check: a request for `../../trawlarr.db` is
   * simply not a manifest entry, so it is never joined against a directory.
   * Never build this by joining an unchecked path onto `rootFor(hash)`.
   */
  filePath(hash: string, relPath: string): string | null;
}

interface CacheEntry {
  maxMtimeMs: number;
  hash: string;
  manifest: BundleManifest;
}

export const createBundleStore = (limits?: {
  maxFiles?: number;
  maxBytes?: number;
}): BundleStore => {
  const resolvedLimits = {
    maxFiles: limits?.maxFiles ?? DEFAULT_MAX_FILES,
    maxBytes: limits?.maxBytes ?? DEFAULT_MAX_BYTES,
  };

  const cacheByRoot = new Map<string, CacheEntry>();
  const rootByHash = new Map<string, string>();
  // hash -> relPath -> absPath, so `filePath` never joins a caller-supplied
  // path onto a root: only a path this store already listed can resolve.
  const filesByHash = new Map<string, Map<string, string>>();

  return {
    async manifestFor(root) {
      const walked = walkTree(root, resolvedLimits);
      const maxMtimeMs = walked.reduce((max, file) => Math.max(max, file.mtimeMs), 0);

      const cached = cacheByRoot.get(root);
      if (cached !== undefined && cached.maxMtimeMs === maxMtimeMs) {
        return { hash: cached.hash, manifest: cached.manifest };
      }

      const files: BundleFile[] = [];
      const pathIndex = new Map<string, string>();
      for (const file of walked) {
        const content = await readFile(file.absPath);
        const sha256 = createHash('sha256').update(content).digest('hex');
        files.push({ relPath: file.relPath, sha256, sizeBytes: file.sizeBytes });
        pathIndex.set(file.relPath, file.absPath);
      }
      files.sort((a, b) => compareRelPath(a.relPath, b.relPath));

      const manifest: BundleManifest = { files };
      const hash = bundleHash(manifest);

      cacheByRoot.set(root, { maxMtimeMs, hash, manifest });
      rootByHash.set(hash, root);
      filesByHash.set(hash, pathIndex);

      return { hash, manifest };
    },

    rootFor(hash) {
      return rootByHash.get(hash) ?? null;
    },

    filePath(hash, relPath) {
      const index = filesByHash.get(hash);
      if (index === undefined) return null;
      return index.get(relPath) ?? null;
    },
  };
};
