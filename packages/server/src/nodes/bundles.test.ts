import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleHash, createBundleStore, type BundleManifest } from './bundles.js';

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

  it('caches the manifest by (root, max mtime) and recomputes after a file changes', async () => {
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
});
