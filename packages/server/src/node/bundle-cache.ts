import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { bundleHash, type BundleFile, type BundleManifest } from '../nodes/bundles.js';

/**
 * A verified, content-addressed cache of plugin bundles on a remote node.
 *
 * A remote node runs third-party, unsandboxed plugin code (see AGENTS.md) it
 * did not write and has no reason to trust just because a server claims a
 * hash for it. Every byte that lands under `<dir>/<hash>/` is therefore
 * checked against the manifest the hash itself commits to — file contents by
 * sha256, the manifest as a whole by `bundleHash` — before that directory
 * ever exists. `ensure` only ever renames a fully-verified download into
 * place, so a present `<hash>/` directory can be trusted as complete without
 * re-checking it on every use.
 */

export interface BundleCache {
  /**
   * Ensure the bundle is present and verified; returns its root directory.
   *
   * The bundle is HELD from the moment this is called until a matching
   * `release`: `prune` never removes a held bundle. A call that rejects holds
   * nothing.
   */
  ensure(hash: string): Promise<string>;
  /** Give up one hold taken by a successful `ensure`. */
  release(hash: string): void;
  /** Remove least-recently-used bundles nothing holds until the cache fits `maxBytes`. */
  prune(maxBytes: number): Promise<void>;
}

const HEX64 = /^[0-9a-f]{64}$/;

export class BundleCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleCacheError';
  }
}

/**
 * Rebuilds each file entry with keys in the exact order `bundleHash` hashes
 * (`relPath, sha256, sizeBytes`), after strictly checking their shape —
 * surplus keys, or a value of the wrong type, cannot ride along to influence
 * or spoof the hash the node is about to trust.
 */
const validateManifestShape = (raw: unknown): BundleManifest => {
  if (typeof raw !== 'object' || raw === null || !('files' in raw)) {
    throw new BundleCacheError('Bundle manifest is not an object with a "files" array.');
  }
  const filesRaw = (raw as { files: unknown }).files;
  if (!Array.isArray(filesRaw)) {
    throw new BundleCacheError('Bundle manifest "files" is not an array.');
  }
  const files: BundleFile[] = filesRaw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new BundleCacheError(`Bundle manifest file at index ${index} is not an object.`);
    }
    const relPath = (entry as Record<string, unknown>)['relPath'];
    const sha256 = (entry as Record<string, unknown>)['sha256'];
    const sizeBytes = (entry as Record<string, unknown>)['sizeBytes'];
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new BundleCacheError(`Bundle manifest file at index ${index} has an invalid relPath.`);
    }
    if (typeof sha256 !== 'string' || !HEX64.test(sha256)) {
      throw new BundleCacheError(`Bundle manifest file at index ${index} has an invalid sha256.`);
    }
    if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
      throw new BundleCacheError(
        `Bundle manifest file at index ${index} has an invalid sizeBytes.`,
      );
    }
    return { relPath, sha256, sizeBytes };
  });
  return { files };
};

/**
 * Rejects an absolute path, any `..` segment, an empty segment (leading,
 * trailing, or doubled slash), and a backslash (which Windows treats as a
 * separator but POSIX `join` would not) — a manifest is data from the
 * network, not a trusted filesystem path.
 */
const isSafeRelPath = (relPath: string): boolean => {
  if (relPath.length === 0 || relPath.includes('\\') || relPath.startsWith('/')) return false;
  const segments = relPath.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};

/** Belt-and-braces on top of `isSafeRelPath`: the resolved path must stay inside `root`. */
const resolveWithinRoot = (root: string, relPath: string): string => {
  const absPath = resolve(root, relPath);
  const rootWithSep = resolve(root) + sep;
  if (absPath !== resolve(root) && !absPath.startsWith(rootWithSep)) {
    throw new BundleCacheError(`Bundle relPath "${relPath}" resolves outside its bundle.`);
  }
  return absPath;
};

const LAST_USED_SUFFIX = '.last-used';
const MANIFEST_SUFFIX = '.manifest.json';
const PARTIAL_INFIX = '.partial-';

const isBundleDirName = (name: string): boolean =>
  HEX64.test(name) &&
  !name.endsWith(LAST_USED_SUFFIX) &&
  !name.endsWith(MANIFEST_SUFFIX) &&
  !name.includes(PARTIAL_INFIX);

export const createBundleCache = (input: {
  dir: string;
  fetchManifest: (hash: string) => Promise<unknown>;
  fetchFile: (hash: string, relPath: string) => Promise<Buffer>;
  /** Seam for tests: called as a bundle's removal begins. */
  onRemoving?: (hash: string) => void;
}): BundleCache => {
  const { dir, fetchManifest, fetchFile } = input;

  /**
   * How many unreleased `ensure` calls each bundle has.
   *
   * A running agent `require`s plugin files lazily out of its bundle, so a
   * bundle must outlive every job using it. That used to be arranged by only
   * pruning while the node was idle — which meant a node that was never idle
   * never pruned, and the cache grew without bound. Counting holds lets prune
   * run at any time and skip exactly the bundles in use.
   */
  const holds = new Map<string, number>();

  /**
   * Bundles being deleted right now. `ensure` waits one out and downloads
   * afresh rather than `existsSync`-ing a directory that is half gone: prune
   * used to decide, then delete, and a job that asked in between was handed
   * a path that vanished, failed to load its plugin, and spent an attempt.
   */
  const removing = new Map<string, Promise<void>>();

  const hold = (hash: string): void => {
    holds.set(hash, (holds.get(hash) ?? 0) + 1);
  };
  const unhold = (hash: string): void => {
    const count = holds.get(hash) ?? 0;
    if (count <= 1) holds.delete(hash);
    else holds.set(hash, count - 1);
  };

  const bundleDir = (hash: string): string => join(dir, hash);
  const manifestPath = (hash: string): string => join(dir, `${hash}${MANIFEST_SUFFIX}`);
  const lastUsedPath = (hash: string): string => join(dir, `${hash}${LAST_USED_SUFFIX}`);

  const touch = async (hash: string): Promise<void> => {
    await writeFile(lastUsedPath(hash), String(Date.now()));
  };

  /**
   * Downloads shared across concurrent `ensure(hash)` calls for the same
   * hash. Without this, two callers racing an uncached hash each build their
   * own `<hash>.partial-<random>/`, both verify successfully, and the loser
   * of the `rename` race gets `ENOTEMPTY`/`EEXIST` — a spurious failure for
   * a caller that asked for a bundle that DOES end up present. Keyed by
   * hash, not by call: the entry is removed once the shared promise settles
   * (success or failure), so a later `ensure` for the same hash tries again
   * rather than replaying a stale rejection.
   */
  const inFlight = new Map<string, Promise<string>>();

  const downloadAndInstall = async (hash: string, finalDir: string): Promise<string> => {
    const rawManifest = await fetchManifest(hash);
    const manifest = validateManifestShape(rawManifest);
    const computedHash = bundleHash(manifest);
    if (computedHash !== hash) {
      throw new BundleCacheError(
        `Bundle manifest hash mismatch: expected "${hash}", computed "${computedHash}".`,
      );
    }

    await mkdir(dir, { recursive: true });
    const partialDir = join(dir, `${hash}${PARTIAL_INFIX}${randomBytes(6).toString('hex')}`);
    await mkdir(partialDir, { recursive: true });

    try {
      for (const file of manifest.files) {
        if (!isSafeRelPath(file.relPath)) {
          throw new BundleCacheError(`Bundle manifest relPath "${file.relPath}" is unsafe.`);
        }
        const absPath = resolveWithinRoot(partialDir, file.relPath);

        const bytes = await fetchFile(hash, file.relPath);
        if (bytes.length !== file.sizeBytes) {
          throw new BundleCacheError(
            `Bundle file "${file.relPath}" size mismatch: expected ${file.sizeBytes}, got ${bytes.length}.`,
          );
        }
        const actualSha256 = createHash('sha256').update(bytes).digest('hex');
        if (actualSha256 !== file.sha256) {
          throw new BundleCacheError(
            `Bundle file "${file.relPath}" sha256 mismatch: expected ${file.sha256}, got ${actualSha256}.`,
          );
        }

        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, bytes);
      }

      await writeFile(manifestPath(hash), JSON.stringify(manifest));

      try {
        await rename(partialDir, finalDir);
      } catch (renameError) {
        // A single node process can only race itself here (the `inFlight`
        // map above already dedupes that); a second node process racing the
        // same download is prevented by the daemon's kernel file lock over
        // its data dir (see AGENTS.md). Checked anyway, cheaply: if the
        // target now exists, someone else finished first, and that is a
        // successful outcome for this caller too, not a failure.
        if (existsSync(finalDir)) {
          await rm(partialDir, { recursive: true, force: true });
          await touch(hash);
          return finalDir;
        }
        throw renameError;
      }
    } catch (error) {
      await rm(partialDir, { recursive: true, force: true });
      throw error;
    }

    await touch(hash);
    return finalDir;
  };

  return {
    async ensure(hash) {
      if (!HEX64.test(hash)) {
        throw new BundleCacheError(`Bundle hash "${hash}" is not a sha256 hex digest.`);
      }
      // Held BEFORE the first await: prune checks holds in the same tick it
      // commits to a removal, so from here it can no longer pick this bundle.
      hold(hash);
      try {
        // Unless it already had. Wait for that removal to finish, then fall
        // through to a fresh download.
        await removing.get(hash);

        const finalDir = bundleDir(hash);
        if (existsSync(finalDir)) {
          await touch(hash);
          return finalDir;
        }

        const existing = inFlight.get(hash);
        if (existing !== undefined) return await existing;

        const promise = downloadAndInstall(hash, finalDir).finally(() => {
          inFlight.delete(hash);
        });
        inFlight.set(hash, promise);
        return await promise;
      } catch (error) {
        unhold(hash);
        throw error;
      }
    },

    release: unhold,

    async prune(maxBytes) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }

      // A partial dir survives only for the lifetime of one download; one
      // left on disk with no matching in-flight hash is dead weight from a
      // process that died mid-download (a normal failure already cleans its
      // own partial up in `downloadAndInstall`'s catch). Never touch one
      // whose hash IS in flight — that's a live download, not litter.
      for (const name of names) {
        const infixAt = name.indexOf(PARTIAL_INFIX);
        if (infixAt === -1) continue;
        const hash = name.slice(0, infixAt);
        if (inFlight.has(hash)) continue;
        await rm(join(dir, name), { recursive: true, force: true });
      }

      const hashes = names.filter(isBundleDirName);

      const entries: { hash: string; sizeBytes: number; lastUsedMs: number }[] = [];
      for (const hash of hashes) {
        let manifest: BundleManifest;
        try {
          manifest = JSON.parse(await readFile(manifestPath(hash), 'utf8')) as BundleManifest;
        } catch {
          manifest = { files: [] };
        }
        const sizeBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
        let lastUsedMs: number;
        try {
          lastUsedMs = (await stat(lastUsedPath(hash))).mtimeMs;
        } catch {
          try {
            lastUsedMs = (await stat(bundleDir(hash))).mtimeMs;
          } catch {
            lastUsedMs = 0;
          }
        }
        entries.push({ hash, sizeBytes, lastUsedMs });
      }

      entries.sort((a, b) => a.lastUsedMs - b.lastUsedMs);

      let total = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      for (const entry of entries) {
        if (total <= maxBytes) break;
        const { hash } = entry;
        // Checked here, not when the directory was listed: a job may have
        // taken a hold during any await above. A held bundle still counts
        // toward the total — it is on disk — so the cache can sit over its
        // cap while jobs need what is in it.
        if (holds.has(hash) || removing.has(hash)) continue;
        // No await between that check and this `set`, so an `ensure` either
        // held the bundle first (and it is skipped) or sees the removal.
        const removal = (async (): Promise<void> => {
          await rm(bundleDir(hash), { recursive: true, force: true });
          await rm(manifestPath(hash), { force: true });
          await rm(lastUsedPath(hash), { force: true });
        })().finally(() => {
          removing.delete(hash);
        });
        removing.set(hash, removal);
        input.onRemoving?.(hash);
        await removal;
        total -= entry.sizeBytes;
      }
    },
  };
};
