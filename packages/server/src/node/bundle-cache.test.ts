import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBundleStore, type BundleManifest, type BundleStore } from '../nodes/bundles.js';
import { createBundleCache } from './bundle-cache.js';

let cacheDir: string;
let store: BundleStore;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'trawlarr-bundle-cache-'));
  store = createBundleStore();
});

const makeSourceTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-bundle-src-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
};

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

/** Fetchers that serve a real bundle from a real `BundleStore`-managed tree. */
const fetchersFor = (root: string) => {
  let manifestCalls = 0;
  let fileCalls = 0;
  const fetchManifest = async (hash: string): Promise<unknown> => {
    manifestCalls += 1;
    const { hash: builtHash, manifest } = await store.manifestFor(root);
    if (builtHash !== hash) throw new Error('unknown hash');
    return manifest;
  };
  const fetchFile = async (hash: string, relPath: string): Promise<Buffer> => {
    fileCalls += 1;
    const absPath = store.filePath(hash, relPath);
    if (absPath === null) throw new Error(`unknown file ${relPath}`);
    return readFile(absPath);
  };
  return {
    fetchManifest,
    fetchFile,
    get manifestCalls() {
      return manifestCalls;
    },
    get fileCalls() {
      return fileCalls;
    },
  };
};

describe('createBundleCache', () => {
  it('downloads and verifies a bundle, then fetches nothing on a second ensure', async () => {
    const root = makeSourceTree({ 'index.js': 'module.exports = 1;', 'lib/helper.js': 'x' });
    const { hash } = await store.manifestFor(root);
    const fetchers = fetchersFor(root);
    const cache = createBundleCache({ dir: cacheDir, ...fetchers });

    const bundleDir = await cache.ensure(hash);
    expect(readFileSync(join(bundleDir, 'index.js'), 'utf8')).toBe('module.exports = 1;');
    expect(readFileSync(join(bundleDir, 'lib/helper.js'), 'utf8')).toBe('x');

    const manifestCallsAfterFirst = fetchers.manifestCalls;
    const fileCallsAfterFirst = fetchers.fileCalls;
    expect(manifestCallsAfterFirst).toBeGreaterThan(0);
    expect(fileCallsAfterFirst).toBeGreaterThan(0);

    const again = await cache.ensure(hash);
    expect(again).toBe(bundleDir);
    expect(fetchers.manifestCalls).toBe(manifestCallsAfterFirst);
    expect(fetchers.fileCalls).toBe(fileCallsAfterFirst);
  });

  it('rejects a bundle whose file bytes were tampered with', async () => {
    const root = makeSourceTree({ 'index.js': 'original content' });
    const { hash } = await store.manifestFor(root);
    const fetchers = fetchersFor(root);
    const tamperedFetchFile = async (): Promise<Buffer> => Buffer.from('tampered!!');
    const cache = createBundleCache({
      dir: cacheDir,
      fetchManifest: fetchers.fetchManifest,
      fetchFile: tamperedFetchFile,
    });

    await expect(cache.ensure(hash)).rejects.toThrow();
    expect(existsSync(join(cacheDir, hash))).toBe(false);
  });

  it('rejects a manifest whose hash does not match', async () => {
    const root = makeSourceTree({ 'index.js': 'content' });
    const { manifest } = await store.manifestFor(root);
    const claimedHash = 'a'.repeat(64);
    const cache = createBundleCache({
      dir: cacheDir,
      fetchManifest: async () => manifest,
      fetchFile: async () => Buffer.from('content'),
    });

    await expect(cache.ensure(claimedHash)).rejects.toThrow();
    expect(existsSync(join(cacheDir, claimedHash))).toBe(false);
  });

  it('rejects a manifest relPath that escapes the bundle', async () => {
    const content = 'evil';
    const maliciousManifest: BundleManifest = {
      files: [{ relPath: '../x', sha256: sha256(content), sizeBytes: content.length }],
    };
    const { bundleHash } = await import('../nodes/bundles.js');
    const hash = bundleHash(maliciousManifest);
    const cache = createBundleCache({
      dir: cacheDir,
      fetchManifest: async () => maliciousManifest,
      fetchFile: async () => Buffer.from(content),
    });

    await expect(cache.ensure(hash)).rejects.toThrow();
    expect(existsSync(join(cacheDir, hash))).toBe(false);
    // Nothing escaped: the cache dir itself gained no stray sibling files.
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('prune removes the older of two bundles', async () => {
    const rootA = makeSourceTree({ 'a.js': 'aaaaaaaaaa' });
    const rootB = makeSourceTree({ 'b.js': 'bbbbbbbbbb' });
    const { hash: hashA } = await store.manifestFor(rootA);
    const { hash: hashB } = await store.manifestFor(rootB);
    const fetchersA = fetchersFor(rootA);
    const fetchersB = fetchersFor(rootB);

    const cache = createBundleCache({
      dir: cacheDir,
      fetchManifest: async (h) =>
        h === hashA ? fetchersA.fetchManifest(h) : fetchersB.fetchManifest(h),
      fetchFile: async (h, relPath) =>
        h === hashA ? fetchersA.fetchFile(h, relPath) : fetchersB.fetchFile(h, relPath),
    });

    await cache.ensure(hashA);
    await cache.ensure(hashB);
    cache.release(hashA);
    cache.release(hashB);

    // Force a deterministic recency order without a real sleep.
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(join(cacheDir, `${hashA}.last-used`), older, older);
    utimesSync(join(cacheDir, `${hashB}.last-used`), newer, newer);

    const sizeOfOne = 10; // each source file is 10 bytes
    await cache.prune(sizeOfOne);

    expect(existsSync(join(cacheDir, hashA))).toBe(false);
    expect(existsSync(join(cacheDir, hashB))).toBe(true);
  });

  it('prune leaves a bundle a job still holds, however far over the cap, and removes it once released', async () => {
    // A running agent `require`s plugin files lazily out of its bundle, so
    // the bundle must outlive the job. Pruning used to be skipped entirely
    // while any job ran instead, and a node that was never idle never pruned.
    const root = makeSourceTree({ 'index.js': 'held by a job' });
    const { hash } = await store.manifestFor(root);
    const cache = createBundleCache({ dir: cacheDir, ...fetchersFor(root) });

    await cache.ensure(hash);
    await cache.ensure(hash); // a second job on the same bundle
    await cache.prune(0);
    expect(existsSync(join(cacheDir, hash, 'index.js'))).toBe(true);

    cache.release(hash);
    await cache.prune(0);
    expect(existsSync(join(cacheDir, hash))).toBe(true);

    cache.release(hash);
    await cache.prune(0);
    expect(existsSync(join(cacheDir, hash))).toBe(false);
  });

  it('never hands out a bundle a prune under way goes on to delete', async () => {
    // Prune reads the directory, then deletes. A job that asked for a bundle
    // in between was given a directory that then vanished, its plugin failed
    // to load, and the file spent an attempt.
    const root = makeSourceTree({ 'index.js': 'raced' });
    const { hash } = await store.manifestFor(root);
    const fetchers = fetchersFor(root);
    const cache = createBundleCache({ dir: cacheDir, ...fetchers });
    await cache.ensure(hash);
    cache.release(hash);

    const pruning = cache.prune(0);
    const dir = await cache.ensure(hash);
    await pruning;

    expect(existsSync(join(dir, 'index.js'))).toBe(true);
  });

  it('downloads a bundle again when it is asked for while being deleted', async () => {
    const root = makeSourceTree({ 'index.js': 'again' });
    const { hash } = await store.manifestFor(root);
    const fetchers = fetchersFor(root);
    let asked: Promise<string> | null = null;
    const cache = createBundleCache({
      dir: cacheDir,
      ...fetchers,
      // The moment the removal starts is the moment a job asks for it.
      onRemoving: (removing) => {
        if (removing === hash) asked = cache.ensure(hash);
      },
    });
    await cache.ensure(hash);
    cache.release(hash);

    await cache.prune(0);
    expect(asked).not.toBeNull();
    const dir = await asked!;

    expect(existsSync(join(dir, 'index.js'))).toBe(true);
    expect(fetchers.manifestCalls).toBe(2);
  });

  it('releases its hold on a bundle that failed to download', async () => {
    const root = makeSourceTree({ 'index.js': 'ok' });
    const { hash } = await store.manifestFor(root);
    const fetchers = fetchersFor(root);
    let fail = true;
    const cache = createBundleCache({
      dir: cacheDir,
      fetchManifest: (h) =>
        fail ? Promise.reject(new Error('offline')) : fetchers.fetchManifest(h),
      fetchFile: fetchers.fetchFile,
    });
    await expect(cache.ensure(hash)).rejects.toThrow('offline');

    fail = false;
    await cache.ensure(hash);
    cache.release(hash);
    await cache.prune(0);
    // Still held by the failed call, this would have survived for ever.
    expect(existsSync(join(cacheDir, hash))).toBe(false);
  });

  it('shares one download across concurrent ensure() calls for the same hash', async () => {
    const root = makeSourceTree({ 'index.js': 'concurrent', 'lib/a.js': 'a' });
    const { hash } = await store.manifestFor(root);
    const fetchers = fetchersFor(root);
    const cache = createBundleCache({ dir: cacheDir, ...fetchers });

    const [first, second] = await Promise.allSettled([cache.ensure(hash), cache.ensure(hash)]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    const dirA = first.status === 'fulfilled' ? first.value : null;
    const dirB = second.status === 'fulfilled' ? second.value : null;
    expect(dirA).toBe(dirB);
    expect(dirA).toBe(join(cacheDir, hash));
    expect(fetchers.manifestCalls).toBe(1);
  });

  it('prune sweeps a leftover partial dir that is not in flight', async () => {
    const root = makeSourceTree({ 'index.js': 'x' });
    const { hash } = await store.manifestFor(root);
    const cache = createBundleCache({
      dir: cacheDir,
      fetchManifest: async () => {
        throw new Error('should not be called for a stale-partial sweep');
      },
      fetchFile: async () => {
        throw new Error('should not be called for a stale-partial sweep');
      },
    });

    const stalePartial = join(cacheDir, `${hash}.partial-deadbeef`);
    mkdirSync(stalePartial, { recursive: true });
    writeFileSync(join(stalePartial, 'index.js'), 'x');

    await cache.prune(0);

    expect(existsSync(stalePartial)).toBe(false);
  });
});
