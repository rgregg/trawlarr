import { describe, expect, it } from 'vitest';
import { utimesSync, writeFileSync } from 'node:fs';
import { PluginLoadError, createPluginLoader } from './loader.js';
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

  it('derives a stable id from the path when none is given', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    expect(loader.load(abs).id).toBe(loader.load(abs).id);
  });

  it('defaults the version to requiresVersion when not supplied', () => {
    const abs = writePluginFile(simplePluginCode());
    expect(createPluginLoader().load(abs).version).toBe('2.11.01');
  });

  it('prefers an explicitly supplied version', () => {
    const abs = writePluginFile(simplePluginCode());
    expect(createPluginLoader().load(abs, { version: '3.0.0' }).version).toBe('3.0.0');
  });

  it('caches by path and mtime', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    expect(loader.load(abs).module).toBe(loader.load(abs).module);
  });

  it('reloads when the file changes on disk', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    const first = loader.load(abs);
    writeFileSync(abs, simplePluginCode(2), 'utf8');
    const later = new Date(Date.now() + 5000);
    utimesSync(abs, later, later);
    expect(loader.load(abs).module).not.toBe(first.module);
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
