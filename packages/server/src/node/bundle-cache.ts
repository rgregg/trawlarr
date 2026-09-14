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
  /** Ensure the bundle is present and verified; returns its root directory. */
  ensure(hash: string): Promise<string>;
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
}): BundleCache => {
  const { dir, fetchManifest, fetchFile } = input;

  const bundleDir = (hash: string): string => join(dir, hash);
  const manifestPath = (hash: string): string => join(dir, `${hash}${MANIFEST_SUFFIX}`);
  const lastUsedPath = (hash: string): string => join(dir, `${hash}${LAST_USED_SUFFIX}`);

  const touch = async (hash: string): Promise<void> => {
    await writeFile(lastUsedPath(hash), String(Date.now()));
  };

  return {
    async ensure(hash) {
      if (!HEX64.test(hash)) {
        throw new BundleCacheError(`Bundle hash "${hash}" is not a sha256 hex digest.`);
      }
      const finalDir = bundleDir(hash);
      if (existsSync(finalDir)) {
        await touch(hash);
        return finalDir;
      }

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
        await rename(partialDir, finalDir);
      } catch (error) {
        await rm(partialDir, { recursive: true, force: true });
        throw error;
      }

      await touch(hash);
      return finalDir;
    },

    async prune(maxBytes) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
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
        await rm(bundleDir(entry.hash), { recursive: true, force: true });
        await rm(manifestPath(entry.hash), { force: true });
        await rm(lastUsedPath(entry.hash), { force: true });
        total -= entry.sizeBytes;
      }
    },
  };
};
