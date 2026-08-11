import { describe, expect, it } from 'vitest';
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import { PluginLoadError, contentVersion, createPluginLoader } from './loader.js';
import { simplePluginCode, writePluginFile } from '../../test/fixtures/make-plugin.js';

describe('createPluginLoader', () => {
  it('loads a plugin and reads its details', () => {
    const abs = writePluginFile(simplePluginCode());
    const loaded = createPluginLoader().load(abs);
    expect(loaded.details.name).toBe('Test Plugin');
    expect(loaded.details.outputs).toHaveLength(2);
    expect(typeof loaded.module.plugin).toBe('function');
    expect(loaded.absPath).toBe(abs);
  });

  it('derives the id from the plugin path, so two loaders agree on it', () => {
    const code = simplePluginCode();
    const abs = writePluginFile(code);
    const other = writePluginFile(code);

    // Same path, independent loaders (no shared cache to satisfy the check
    // trivially) => same id. Different path, identical bytes => different id.
    expect(createPluginLoader().load(abs).id).toBe(createPluginLoader().load(abs).id);
    expect(createPluginLoader().load(abs).id).toMatch(/^[0-9a-f]{16}$/);
    expect(createPluginLoader().load(other).id).not.toBe(createPluginLoader().load(abs).id);
  });

  it('defaults the version to a hash of the plugin source, not requiresVersion', () => {
    // requiresVersion ('2.11.01' in the fixture) is the host level the plugin
    // demands, not a version of the plugin. Using it meant a plugin whose code
    // changed reported an unchanged version.
    const code = simplePluginCode();
    const abs = writePluginFile(code);
    const version = createPluginLoader().load(abs).version;

    expect(version).toBe(contentVersion(code));
    expect(version).toMatch(/^sha256-[0-9a-f]{16}$/);
    expect(version).not.toBe('2.11.01');
  });

  it('changes the default version when the plugin source changes', () => {
    const first = writePluginFile(simplePluginCode(1));
    const second = writePluginFile(simplePluginCode(2));
    expect(createPluginLoader().load(first).version).not.toBe(
      createPluginLoader().load(second).version,
    );
  });

  it('keeps the default version stable for identical source at a different path', () => {
    const code = simplePluginCode();
    expect(createPluginLoader().load(writePluginFile(code)).version).toBe(
      createPluginLoader().load(writePluginFile(code)).version,
    );
  });

  it('prefers an explicitly supplied version', () => {
    const abs = writePluginFile(simplePluginCode());
    expect(createPluginLoader().load(abs, { version: '3.0.0' }).version).toBe('3.0.0');
  });

  it('caches by path and content hash', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    expect(loader.load(abs).module).toBe(loader.load(abs).module);
  });

  it('reloads when the file contents change on disk', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    const first = loader.load(abs);
    writeFileSync(abs, simplePluginCode(2), 'utf8');
    const later = new Date(Date.now() + 5000);
    utimesSync(abs, later, later);
    expect(loader.load(abs).module).not.toBe(first.module);
    expect(loader.load(abs).version).not.toBe(first.version);
  });

  it('reloads changed contents even when the mtime is unchanged', () => {
    // The reason the key is a content hash: mtime granularity is coarse on
    // some filesystems, and tooling routinely restores timestamps. Keyed on
    // mtime, this rewrite would have served the stale module forever.
    const abs = writePluginFile(simplePluginCode());
    // Pin to a whole second so restoring it afterwards is exact — sub-ms
    // timestamps do not survive a round trip through utimes on every platform.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(abs, pinned, pinned);

    const loader = createPluginLoader();
    const first = loader.load(abs);
    const before = statSync(abs).mtimeMs;

    writeFileSync(abs, simplePluginCode(2), 'utf8');
    utimesSync(abs, pinned, pinned);
    expect(statSync(abs).mtimeMs).toBe(before);

    const reloaded = loader.load(abs);
    expect(reloaded.module).not.toBe(first.module);
    expect(reloaded.version).not.toBe(first.version);
  });

  it('serves the cache when a rewrite restores the identical contents', () => {
    const code = simplePluginCode();
    const abs = writePluginFile(code);
    const loader = createPluginLoader();
    const first = loader.load(abs);
    writeFileSync(abs, code, 'utf8');
    expect(loader.load(abs).module).toBe(first.module);
  });

  it('bypasses the cache when asked for a fresh load', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    expect(loader.load(abs, { fresh: true }).module).not.toBe(loader.load(abs).module);
  });

  it('rejects a file that is not a plugin', () => {
    const abs = writePluginFile(`module.exports = { nope: true };`);
    expect(() => createPluginLoader().load(abs)).toThrow(PluginLoadError);
    expect(() => createPluginLoader().load(abs)).toThrow(/must export.*details.*plugin/i);
  });

  it('rejects details() that omits outputs, which the editor cannot render', () => {
    const abs = writePluginFile(`
      module.exports = {
        details: () => ({ name: 'x', description: '', style: {}, tags: '', inputs: [] }),
        plugin: () => ({}),
      };
    `);
    expect(() => createPluginLoader().load(abs)).toThrow(/outputs/i);
  });

  it('names the file in the error when details() throws', () => {
    const abs = writePluginFile(`
      module.exports = { details: () => { throw new Error('bad details'); }, plugin: () => ({}) };
    `);
    try {
      createPluginLoader().load(abs);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginLoadError);
      expect((error as PluginLoadError).absPath).toBe(abs);
      expect((error as Error).message).toMatch(/bad details/);
    }
  });

  it('reports a missing file clearly', () => {
    expect(() => createPluginLoader().load('/nope/missing.js')).toThrow(PluginLoadError);
  });
});
