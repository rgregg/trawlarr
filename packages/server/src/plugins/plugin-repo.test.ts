import { describe, expect, it } from 'vitest';
import type { PluginDetails } from '@trawlarr/plugin-api';
import { createPluginRepo } from './plugin-repo.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

/** Same pattern as `packages/server/src/db/flow-repo.test.ts`. */
const openTestDb = () => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  return db;
};

const details = (name: string): PluginDetails =>
  ({
    name,
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
  }) as PluginDetails;

describe('plugin sources', () => {
  it('stores and lists a source', () => {
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'tdarr', url: 'https://example.test/x.tar.gz', kind: 'tarball' });
    expect(repo.listSources()).toEqual([
      {
        id: 'tdarr',
        url: 'https://example.test/x.tar.gz',
        kind: 'tarball',
        enabled: true,
        lastSyncedAtMs: null,
      },
    ]);
  });

  it('refuses a second source with the same url, by name', () => {
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'a', url: 'https://example.test/x.tar.gz', kind: 'tarball' });
    expect(() =>
      repo.addSource({ id: 'b', url: 'https://example.test/x.tar.gz', kind: 'tarball' }),
    ).toThrow(/already/i);
  });

  it('refuses a source named trawlarr', () => {
    const repo = createPluginRepo(openTestDb());
    expect(() => repo.addSource({ id: 'trawlarr', url: 'file:///x', kind: 'local' })).toThrow(
      /reserved/i,
    );
  });

  it('keeps each source distinct on read, so no field is transposed', () => {
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'alpha', url: 'https://one.test/a.tar.gz', kind: 'tarball' });
    repo.addSource({ id: 'beta-local', url: '/srv/beta', kind: 'local' });
    repo.setSourceEnabled('beta-local', false);
    repo.markSynced('alpha', 1_700_000_000_123);

    expect(repo.getSource('alpha')).toEqual({
      id: 'alpha',
      url: 'https://one.test/a.tar.gz',
      kind: 'tarball',
      enabled: true,
      lastSyncedAtMs: 1_700_000_000_123,
    });
    expect(repo.getSource('beta-local')).toEqual({
      id: 'beta-local',
      url: '/srv/beta',
      kind: 'local',
      enabled: false,
      lastSyncedAtMs: null,
    });
    expect(repo.getSource('gamma')).toBeNull();
  });

  it('rejects a kind a human typed into the table by hand', () => {
    const db = openTestDb();
    const repo = createPluginRepo(db);
    repo.addSource({ id: 'tdarr', url: '/srv/plugins', kind: 'local' });
    db.prepare(`UPDATE plugin_source SET kind = 'ftp' WHERE id = 'tdarr'`).run();
    expect(() => repo.getSource('tdarr')).toThrow(/ftp/);
  });
});

describe('installed plugins', () => {
  const seed = () => {
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'tdarr', url: '/srv/plugins', kind: 'local' });
    repo.replaceSourcePlugins('tdarr', [
      {
        pluginName: 'ffmpegCommandSetContainer',
        relPath:
          'FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
        absPath:
          '/srv/plugins/FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
        version: '1.0.0',
        details: details('Set Container'),
      },
    ]);
    return repo;
  };

  it('gives each plugin a namespaced id', () => {
    expect(
      seed()
        .listPlugins()
        .map((p) => p.id),
    ).toEqual(['tdarr:ffmpegCommandSetContainer']);
  });

  it('resolves an id to the absolute path the worker will load', () => {
    expect(seed().resolveAbsPaths(['tdarr:ffmpegCommandSetContainer'])).toEqual({
      'tdarr:ffmpegCommandSetContainer':
        '/srv/plugins/FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
    });
  });

  it('returns nothing for an id it does not have, rather than guessing', () => {
    expect(seed().resolveAbsPaths(['tdarr:nope', 'trawlarr:execute'])).toEqual({});
  });

  it('replaces a source-s plugins wholesale, so a plugin deleted upstream disappears', () => {
    // A sync that only upserts leaves a plugin behind after upstream removes
    // it, and a flow keeps referencing a path that no longer exists.
    const repo = seed();
    repo.replaceSourcePlugins('tdarr', []);
    expect(repo.listPlugins()).toEqual([]);
  });

  it('removing a source removes its plugins', () => {
    const repo = seed();
    repo.removeSource('tdarr');
    expect(repo.listPlugins()).toEqual([]);
  });

  it('stores every column of a row distinctly, including the details document', () => {
    const repo = seed();
    expect(repo.getPlugin('tdarr:ffmpegCommandSetContainer')).toEqual({
      id: 'tdarr:ffmpegCommandSetContainer',
      sourceId: 'tdarr',
      relPath:
        'FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
      absPath:
        '/srv/plugins/FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
      version: '1.0.0',
      details: details('Set Container'),
      enabled: true,
    });
    expect(repo.getPlugin('tdarr:absent')).toBeNull();
  });

  it('keeps two sources apart, both in ids and in what each source lists', () => {
    const repo = seed();
    repo.addSource({ id: 'mine', url: '/opt/mine', kind: 'local' });
    repo.replaceSourcePlugins('mine', [
      {
        pluginName: 'ffmpegCommandSetContainer',
        relPath: 'FlowPlugins/Local/ffmpegCommandSetContainer/2.3.4/index.js',
        absPath: '/opt/mine/FlowPlugins/Local/ffmpegCommandSetContainer/2.3.4/index.js',
        version: '2.3.4',
        details: details('My Set Container'),
      },
    ]);

    expect(repo.listPlugins().map((p) => p.id)).toEqual([
      'mine:ffmpegCommandSetContainer',
      'tdarr:ffmpegCommandSetContainer',
    ]);
    expect(repo.listPlugins('mine').map((p) => p.version)).toEqual(['2.3.4']);
    expect(repo.resolveAbsPaths(['mine:ffmpegCommandSetContainer'])).toEqual({
      'mine:ffmpegCommandSetContainer':
        '/opt/mine/FlowPlugins/Local/ffmpegCommandSetContainer/2.3.4/index.js',
    });

    // Replacing one source leaves the other untouched.
    repo.replaceSourcePlugins('mine', []);
    expect(repo.listPlugins().map((p) => p.id)).toEqual(['tdarr:ffmpegCommandSetContainer']);
  });

  it('leaves the previous set intact when a replace fails part way', () => {
    const repo = seed();
    expect(() =>
      repo.replaceSourcePlugins('tdarr', [
        {
          pluginName: 'ffmpegCommandEnsureAudioStream',
          relPath: 'a/1.0.0/index.js',
          absPath: '/srv/plugins/a/1.0.0/index.js',
          version: '1.0.0',
          details: details('Ensure Audio'),
        },
        {
          // Same rel_path as its predecessor: violates UNIQUE (source_id, rel_path).
          pluginName: 'ffmpegCommandRemoveStreamByProperty',
          relPath: 'a/1.0.0/index.js',
          absPath: '/srv/plugins/a/1.0.0/index.js',
          version: '1.0.0',
          details: details('Remove Stream'),
        },
      ]),
    ).toThrow();
    expect(repo.listPlugins().map((p) => p.id)).toEqual(['tdarr:ffmpegCommandSetContainer']);
  });

  it('refuses to write a plugin whose name cannot form an id', () => {
    const repo = seed();
    expect(() =>
      repo.replaceSourcePlugins('tdarr', [
        {
          pluginName: 'has:colon',
          relPath: 'b/1.0.0/index.js',
          absPath: '/srv/plugins/b/1.0.0/index.js',
          version: '1.0.0',
          details: details('Bad'),
        },
      ]),
    ).toThrow(/has:colon/);
    expect(repo.listPlugins().map((p) => p.id)).toEqual(['tdarr:ffmpegCommandSetContainer']);
  });

  it('refuses to attach plugins to a source that does not exist', () => {
    const repo = seed();
    expect(() => repo.replaceSourcePlugins('ghost', [])).toThrow(/ghost/);
  });
});
