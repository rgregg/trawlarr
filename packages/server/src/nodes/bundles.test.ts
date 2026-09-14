import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleHash, createBundleStore, type BundleManifest } from './bundles.js';

const isRoot = (): boolean => process.getuid?.() === 0;

const sha256Of = (content: string): string => createHash('sha256').update(content).digest('hex');

const dirs: string[] = [];

const makeTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'bundle-test-'));
  dirs.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
};

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createBundleStore / manifestFor', () => {
  it('manifests only the regular files in the tree, sorted by relPath', async () => {
    const root = makeTree({
      'a/index.js': 'console.log("a")',
      'FlowHelpers/x.js': 'module.exports = {}',
    });
    // A symlink pointing at a real file must never be walked into the manifest.
    symlinkSync(join(root, 'a/index.js'), join(root, 'a/link.js'));

    const store = createBundleStore();
    const { manifest } = await store.manifestFor(root);

    expect(manifest.files.map((f) => f.relPath)).toEqual(['FlowHelpers/x.js', 'a/index.js']);
    const indexFile = manifest.files.find((f) => f.relPath === 'a/index.js')!;
    expect(indexFile.sha256).toBe(sha256Of('console.log("a")'));
    expect(indexFile.sizeBytes).toBe(Buffer.byteLength('console.log("a")'));
    const helperFile = manifest.files.find((f) => f.relPath === 'FlowHelpers/x.js')!;
    expect(helperFile.sha256).toBe(sha256Of('module.exports = {}'));
  });

  it('excludes a .git directory at any depth', async () => {
    const root = makeTree({
      'a/index.js': 'x',
      '.git/HEAD': 'ref: refs/heads/main',
      'a/.git/HEAD': 'nested',
    });
    const store = createBundleStore();
    const { manifest } = await store.manifestFor(root);
    expect(manifest.files.map((f) => f.relPath)).toEqual(['a/index.js']);
  });

  it('caches the manifest by a signature of the walked list and recomputes after a file changes', async () => {
    const root = makeTree({ 'a/index.js': 'v1' });
    const store = createBundleStore();
    const first = await store.manifestFor(root);
    const second = await store.manifestFor(root);
    expect(second.hash).toBe(first.hash);
    expect(second.manifest).toEqual(first.manifest);

    // Bump mtime and change content, the way a sync overwriting the tree would.
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(join(root, 'a/index.js'), 'v2');
    const third = await store.manifestFor(root);
    expect(third.hash).not.toBe(first.hash);
  });

  it('invalidates the cache when a file that is NOT the tree-wide newest is deleted', async () => {
    // A max-mtime-only cache key is blind to this: removing a.js leaves the
    // tree's newest mtime (on b.js) completely unchanged, so a cache keyed
    // on max-mtime alone would keep serving the stale two-file manifest.
    const root = makeTree({ 'a/old.js': 'old', 'b/new.js': 'new' });
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(join(root, 'a/old.js'), past, past);
    utimesSync(join(root, 'b/new.js'), now, now);

    const store = createBundleStore();
    const first = await store.manifestFor(root);
    expect(first.manifest.files.map((f) => f.relPath)).toEqual(['a/old.js', 'b/new.js']);

    rmSync(join(root, 'a/old.js'));
    const second = await store.manifestFor(root);
    expect(second.manifest.files.map((f) => f.relPath)).toEqual(['b/new.js']);
    expect(second.hash).not.toBe(first.hash);
  });

  it('invalidates the cache when a non-newest file is rewritten to an older-but-different mtime', async () => {
    // Same blind spot from the other direction: the rewritten file's new
    // mtime is still below the tree-wide max (still b/new.js), so only a
    // signature over every file's own identity catches the change.
    const root = makeTree({ 'a/old.js': 'v1', 'b/new.js': 'new' });
    const past = new Date(Date.now() - 60_000);
    const middle = new Date(Date.now() - 30_000);
    const now = new Date();
    utimesSync(join(root, 'a/old.js'), past, past);
    utimesSync(join(root, 'b/new.js'), now, now);

    const store = createBundleStore();
    const first = await store.manifestFor(root);

    writeFileSync(join(root, 'a/old.js'), 'v2');
    utimesSync(join(root, 'a/old.js'), middle, middle);

    const second = await store.manifestFor(root);
    expect(second.hash).not.toBe(first.hash);
    const rewritten = second.manifest.files.find((f) => f.relPath === 'a/old.js')!;
    expect(rewritten.sha256).toBe(sha256Of('v2'));
  });
});

describe('bundleHash', () => {
  it('is stable across two builds of the same tree', async () => {
    const root = makeTree({ 'a/index.js': 'same content' });
    const storeA = createBundleStore();
    const storeB = createBundleStore();
    const a = await storeA.manifestFor(root);
    const b = await storeB.manifestFor(root);
    expect(a.hash).toBe(b.hash);
  });

  it('changes when one byte changes', () => {
    const manifestA: BundleManifest = {
      files: [{ relPath: 'a/index.js', sha256: sha256Of('x'), sizeBytes: 1 }],
    };
    const manifestB: BundleManifest = {
      files: [{ relPath: 'a/index.js', sha256: sha256Of('y'), sizeBytes: 1 }],
    };
    expect(bundleHash(manifestA)).not.toBe(bundleHash(manifestB));
  });
});

describe('rootFor / filePath', () => {
  it('resolves a listed relPath and rejects an unlisted or traversal one', async () => {
    const root = makeTree({ 'a/index.js': 'x' });
    const store = createBundleStore();
    const { hash } = await store.manifestFor(root);

    expect(store.rootFor(hash)).toBe(root);
    expect(store.filePath(hash, 'a/index.js')).toBe(join(root, 'a/index.js'));
    expect(store.filePath(hash, '../outside')).toBeNull();
    expect(store.filePath(hash, 'nope.js')).toBeNull();
    expect(store.rootFor('deadbeef')).toBeNull();
  });
});

describe('limits', () => {
  it('throws a named error naming the limit once maxFiles is exceeded', async () => {
    const root = makeTree({ 'a/index.js': 'x', 'b/index.js': 'y' });
    const store = createBundleStore({ maxFiles: 1 });
    await expect(store.manifestFor(root)).rejects.toThrow(/maxFiles|1/);
  });

  it('throws a named error naming the limit once maxBytes is exceeded', async () => {
    const root = makeTree({ 'a/index.js': 'x'.repeat(100) });
    const store = createBundleStore({ maxBytes: 50 });
    await expect(store.manifestFor(root)).rejects.toThrow(/maxBytes|50/);
  });
});

describe('walk errors', () => {
  // Running as root bypasses directory permission bits entirely, so chmod
  // 000 would not reproduce the failure this test exists to check.
  it.skipIf(isRoot())(
    'names the path and error code rather than silently truncating the bundle',
    async () => {
      const root = makeTree({ 'a/index.js': 'x' });
      const blocked = join(root, 'blocked');
      mkdirSync(blocked);
      writeFileSync(join(blocked, 'index.js'), 'y');
      chmodSync(blocked, 0o000);

      try {
        const store = createBundleStore();
        await expect(store.manifestFor(root)).rejects.toThrow(/blocked/);
      } finally {
        // Restore permissions so afterEach's rmSync can actually delete it.
        chmodSync(blocked, 0o755);
      }
    },
  );
});
