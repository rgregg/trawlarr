import { describe, expect, it } from 'vitest';
import type { PluginDetails } from '@trawlarr/plugin-api';
import { createPluginRegistry } from './registry.js';
import { createPluginRepo } from './plugin-repo.js';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

const details = (): PluginDetails =>
  ({
    name: 'x',
    description: '',
    style: { borderColor: '#fff' },
    tags: '',
    isStartPlugin: false,
    pType: '',
    sidebarPosition: 1,
    icon: '',
    inputs: [],
    outputs: [{ number: 1, tooltip: 'ok' }],
    requiresVersion: '1.0.0',
  }) as unknown as PluginDetails;

const seeded = (): Db => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  const repo = createPluginRepo(db);
  repo.addSource({ id: 'tdarr', url: '/srv/p', kind: 'local' });
  repo.replaceSourcePlugins('tdarr', [
    {
      pluginName: 'ffmpegCommandSetContainer',
      relPath: 'a/ffmpegCommandSetContainer/1.0.0/index.js',
      absPath: '/srv/p/a/ffmpegCommandSetContainer/1.0.0/index.js',
      version: '1.0.0',
      details: details(),
    },
  ]);
  return db;
};

describe('the plugin registry', () => {
  it('resolves an installed id to its absolute path', () => {
    expect(createPluginRegistry(seeded()).resolveAbsPath('tdarr:ffmpegCommandSetContainer')).toBe(
      '/srv/p/a/ffmpegCommandSetContainer/1.0.0/index.js',
    );
  });

  it('answers null for a first-party id, leaving it to the first-party table', () => {
    expect(createPluginRegistry(seeded()).resolveAbsPath('trawlarr:execute')).toBeNull();
  });

  it('answers null for an absolute path, leaving it to the loader', () => {
    expect(createPluginRegistry(seeded()).resolveAbsPath('/media/p/index.js')).toBeNull();
  });

  it('answers null for an id whose source was removed, rather than a stale path', () => {
    // The consistent answer to "referenced but no longer installed", asked at
    // the one place all five call sites ask it. A registry that answered with
    // a remembered path would send the worker at a file that is gone.
    const db = seeded();
    const registry = createPluginRegistry(db);
    createPluginRepo(db).removeSource('tdarr');
    expect(registry.resolveAbsPath('tdarr:ffmpegCommandSetContainer')).toBeNull();
  });

  it('resolveMany returns only the ids it knows', () => {
    expect(
      createPluginRegistry(seeded()).resolveMany([
        'tdarr:ffmpegCommandSetContainer',
        'tdarr:nope',
        'trawlarr:start',
      ]),
    ).toEqual({
      'tdarr:ffmpegCommandSetContainer': '/srv/p/a/ffmpegCommandSetContainer/1.0.0/index.js',
    });
  });

  it('sees a plugin installed after it was constructed', () => {
    // No caching: a sync must take effect on the very next validation, or a
    // user who just installed a plugin is told it does not exist.
    const db = seeded();
    const registry = createPluginRegistry(db);
    createPluginRepo(db).replaceSourcePlugins('tdarr', [
      {
        pluginName: 'newOne',
        relPath: 'a/newOne/1.0.0/index.js',
        absPath: '/srv/p/a/newOne/1.0.0/index.js',
        version: '1.0.0',
        details: details(),
      },
    ]);
    expect(registry.resolveAbsPath('tdarr:newOne')).toBe('/srv/p/a/newOne/1.0.0/index.js');
  });
});
