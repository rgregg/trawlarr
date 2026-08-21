import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverFlowPlugins, syncSource } from './sync-source.js';
import { createPluginRepo } from './plugin-repo.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { CORPUS_DIR, corpusAvailable } from '../../../engine/test/compat/corpus.js';

const openTestDb = () => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  return db;
};

const GOOD_PLUGIN = `
exports.details = () => ({
  name: 'Fixture Plugin',
  description: 'x',
  style: { borderColor: '#fff' },
  tags: '',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: '',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'ok' }],
  requiresVersion: '1.0.0',
});
exports.plugin = (args) => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});
`;

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-sync-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
};

const cache = () => mkdtempSync(join(tmpdir(), 'trawlarr-cache-'));

describe('discovery', () => {
  it('finds a plugin at <name>/<version>/index.js', () => {
    const root = tree({ 'FlowPlugins/x/myPlugin/1.0.0/index.js': GOOD_PLUGIN });
    expect(discoverFlowPlugins(root).map((p) => p.pluginName)).toEqual(['myPlugin']);
  });

  it('ignores an index.js that is not under a version directory', () => {
    const root = tree({ 'src/index.js': GOOD_PLUGIN, 'methods/lib/index.js': GOOD_PLUGIN });
    expect(discoverFlowPlugins(root)).toEqual([]);
  });

  it('ignores classic plugins, which are bare files rather than versioned index.js', () => {
    const root = tree({ 'Community/Tdarr_Plugin_abc_Thing.js': GOOD_PLUGIN });
    expect(discoverFlowPlugins(root)).toEqual([]);
  });

  it('keeps the highest version when a plugin ships several', () => {
    const root = tree({
      'p/myPlugin/1.0.0/index.js': GOOD_PLUGIN,
      'p/myPlugin/1.10.0/index.js': GOOD_PLUGIN,
      'p/myPlugin/1.9.0/index.js': GOOD_PLUGIN,
    });
    // Compared numerically per component, so 1.10.0 beats 1.9.0. A string
    // sort would pick 1.9.0 and silently install the older plugin.
    expect(discoverFlowPlugins(root).map((p) => p.version)).toEqual(['1.10.0']);
  });

  it('records a path relative to the source root, for later flow-import translation', () => {
    const root = tree({ 'a/b/myPlugin/2.1.0/index.js': GOOD_PLUGIN });
    expect(discoverFlowPlugins(root)[0]!.relPath).toBe('a/b/myPlugin/2.1.0/index.js');
  });

  it('ignores a version directory with no plugin name above it', () => {
    // `1.0.0/index.js` at the root has a version but nothing to call the
    // plugin, and installing it would name it after the missing component.
    const root = tree({ '1.0.0/index.js': GOOD_PLUGIN });
    expect(discoverFlowPlugins(root)).toEqual([]);
  });

  it('does not follow a symlinked index.js out of the source tree', () => {
    // Only reachable for a LOCAL source — a tarball carrying a link is
    // refused whole — but a local tree is the user's own, and "the plugin
    // trawlarr installed" should be a file inside the directory they named.
    const outside = tree({ 'elsewhere/index.js': GOOD_PLUGIN });
    const root = tree({ 'p/real/1.0.0/index.js': GOOD_PLUGIN });
    mkdirSync(join(root, 'p', 'linked', '1.0.0'), { recursive: true });
    symlinkSync(
      join(outside, 'elsewhere', 'index.js'),
      join(root, 'p', 'linked', '1.0.0', 'index.js'),
    );

    expect(discoverFlowPlugins(root).map((p) => p.pluginName)).toEqual(['real']);
  });
});

describe('sync', () => {
  it('installs a discovered plugin under the source-s namespace', async () => {
    const root = tree({ 'p/myPlugin/1.0.0/index.js': GOOD_PLUGIN });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });

    const report = await syncSource({
      repo,
      sourceId: 'fixtures',
      cacheDir: cache(),
      nowMs: () => 1_700_000_000_000,
    });

    expect(report.installed).toBe(1);
    const installed = repo.listPlugins();
    expect(installed.map((p) => p.id)).toEqual(['fixtures:myPlugin']);
    expect(installed[0]!.details.name).toBe('Fixture Plugin');
    expect(installed[0]!.version).toBe('1.0.0');
    expect(repo.getSource('fixtures')!.lastSyncedAtMs).toBe(1_700_000_000_000);
  });

  it('skips a plugin that will not load, and names it, rather than installing a broken row', async () => {
    const root = tree({
      'p/good/1.0.0/index.js': GOOD_PLUGIN,
      'p/broken/1.0.0/index.js': 'throw new Error("boom");',
    });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });

    const report = await syncSource({
      repo,
      sourceId: 'fixtures',
      cacheDir: cache(),
      nowMs: () => 1,
    });

    expect(report.installed).toBe(1);
    expect(report.skipped.map((s) => s.relPath)).toEqual(['p/broken/1.0.0/index.js']);
    expect(repo.listPlugins().map((p) => p.id)).toEqual(['fixtures:good']);
  });

  it('skips a module that loads but is not a flow plugin', async () => {
    const root = tree({ 'p/notAPlugin/1.0.0/index.js': 'exports.hello = 1;' });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });
    const report = await syncSource({
      repo,
      sourceId: 'fixtures',
      cacheDir: cache(),
      nowMs: () => 1,
    });
    expect(report.installed).toBe(0);
    expect(report.skipped).toHaveLength(1);
  });

  it('skips a module whose plugin export is not callable', async () => {
    const root = tree({ 'p/notCallable/1.0.0/index.js': GOOD_PLUGIN + '\nexports.plugin = 42;\n' });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });
    const report = await syncSource({
      repo,
      sourceId: 'fixtures',
      cacheDir: cache(),
      nowMs: () => 1,
    });
    expect(report.installed).toBe(0);
    expect(report.skipped[0]!.reason).toMatch(/details\(\) and a plugin\(\) function/);
    expect(repo.listPlugins()).toEqual([]);
  });

  it('skips a plugin whose details() declares no outputs, which no flow could route', async () => {
    const noOutputs = GOOD_PLUGIN.replace("outputs: [{ number: 1, tooltip: 'ok' }]", 'outputs: []');
    const root = tree({
      'p/deadEnd/1.0.0/index.js': noOutputs,
      'p/routable/1.0.0/index.js': GOOD_PLUGIN,
    });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });

    const report = await syncSource({
      repo,
      sourceId: 'fixtures',
      cacheDir: cache(),
      nowMs: () => 1,
    });

    expect(report.skipped).toEqual([
      { relPath: 'p/deadEnd/1.0.0/index.js', reason: 'details() declares no outputs' },
    ]);
    expect(repo.listPlugins().map((p) => p.id)).toEqual(['fixtures:routable']);
  });

  it('a second sync removes a plugin that disappeared upstream', async () => {
    const cacheDir = cache();
    const root = tree({ 'p/a/1.0.0/index.js': GOOD_PLUGIN, 'p/b/1.0.0/index.js': GOOD_PLUGIN });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });
    await syncSource({ repo, sourceId: 'fixtures', cacheDir, nowMs: () => 1 });
    expect(repo.listPlugins()).toHaveLength(2);

    const shrunk = tree({ 'p/a/1.0.0/index.js': GOOD_PLUGIN });
    repo.removeSource('fixtures');
    repo.addSource({ id: 'fixtures', url: shrunk, kind: 'local' });
    await syncSource({ repo, sourceId: 'fixtures', cacheDir, nowMs: () => 2 });
    expect(repo.listPlugins().map((p) => p.id)).toEqual(['fixtures:a']);
  });

  it('leaves the source directory of a local source alone', async () => {
    const root = tree({ 'p/myPlugin/1.0.0/index.js': GOOD_PLUGIN });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });
    await syncSource({ repo, sourceId: 'fixtures', cacheDir: cache(), nowMs: () => 1 });

    expect(readFileSync(join(root, 'p', 'myPlugin', '1.0.0', 'index.js'), 'utf8')).toBe(
      GOOD_PLUGIN,
    );
  });
});

/**
 * A tarball source keeps its extracted copy: the installed row's `absPath`
 * points into it, so deleting it would install a plugin whose file is gone.
 * These check that it survives, that it survives ONLY once, and that a failed
 * re-sync does not take the working copy with it.
 */
describe('sync from a tarball source', () => {
  const makeTarball = (files: Record<string, string>): string => {
    const root = tree(files);
    const payload = join(root, 'wrapper');
    mkdirSync(payload, { recursive: true });
    // One top-level directory wrapping the tree, the shape every GitHub
    // tarball has and the shape --strip-components=1 expects.
    for (const entry of readdirSync(root)) {
      if (entry !== 'wrapper') execFileSync('mv', [join(root, entry), payload]);
    }
    const out = join(mkdtempSync(join(tmpdir(), 'trawlarr-tar-')), 'source.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', root, 'wrapper']);
    return out;
  };

  const serve = (path: string): typeof fetch =>
    (async () => new Response(readFileSync(path), { status: 200 })) as unknown as typeof fetch;

  it('installs from the extracted copy and leaves that copy in place', async () => {
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'remote', url: 'https://plugins.test/x.tar.gz', kind: 'tarball' });

    const report = await syncSource({
      repo,
      sourceId: 'remote',
      cacheDir: cache(),
      nowMs: () => 5,
      fetchFn: serve(makeTarball({ 'p/myPlugin/1.0.0/index.js': GOOD_PLUGIN })),
    });

    expect(report.installed).toBe(1);
    const row = repo.getPlugin('remote:myPlugin')!;
    expect(row.relPath).toBe('p/myPlugin/1.0.0/index.js');
    expect(readFileSync(row.absPath, 'utf8')).toBe(GOOD_PLUGIN);
  });

  it('keeps one extraction per source, not one per sync', async () => {
    const cacheDir = cache();
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'remote', url: 'https://plugins.test/x.tar.gz', kind: 'tarball' });
    const tarball = makeTarball({ 'p/myPlugin/1.0.0/index.js': GOOD_PLUGIN });

    await syncSource({
      repo,
      sourceId: 'remote',
      cacheDir,
      nowMs: () => 5,
      fetchFn: serve(tarball),
    });
    await syncSource({
      repo,
      sourceId: 'remote',
      cacheDir,
      nowMs: () => 6,
      fetchFn: serve(tarball),
    });

    // Left unpruned, every sync of a tarball source would leave another whole
    // copy of the repository in the data directory forever.
    expect(readdirSync(join(cacheDir, 'remote'))).toHaveLength(1);
    expect(existsSync(repo.getPlugin('remote:myPlugin')!.absPath)).toBe(true);
  });

  it('leaves the installed copy on disk when a re-sync cannot fetch', async () => {
    const cacheDir = cache();
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'remote', url: 'https://plugins.test/x.tar.gz', kind: 'tarball' });
    await syncSource({
      repo,
      sourceId: 'remote',
      cacheDir,
      nowMs: () => 5,
      fetchFn: serve(makeTarball({ 'p/myPlugin/1.0.0/index.js': GOOD_PLUGIN })),
    });
    const installedAt = repo.getPlugin('remote:myPlugin')!.absPath;

    const failing = (async () => new Response('gone', { status: 503 })) as unknown as typeof fetch;
    await expect(
      syncSource({ repo, sourceId: 'remote', cacheDir, nowMs: () => 6, fetchFn: failing }),
    ).rejects.toThrow(/503/);

    // The row still says this file is the plugin, so the file has to still be
    // there: a sync that fails must not disarm the plugins already installed.
    expect(readFileSync(installedAt, 'utf8')).toBe(GOOD_PLUGIN);
    expect(repo.getSource('remote')!.lastSyncedAtMs).toBe(5);
  });
});

describe.runIf(corpusAvailable())('against the real Tdarr corpus', () => {
  it('discovers the four plugins the parity pipeline needs', () => {
    const found = new Set(discoverFlowPlugins(CORPUS_DIR).map((p) => p.pluginName));
    expect(found.has('ffmpegCommandSetContainer')).toBe(true);
    expect(found.has('ffmpegCommandEnsureAudioStream')).toBe(true);
    expect(found.has('ffmpegCommandRemoveStreamByProperty')).toBe(true);
    expect(found.has('webRequest')).toBe(true);
  });

  it('does not discover classic plugins', () => {
    const found = discoverFlowPlugins(CORPUS_DIR).map((p) => p.pluginName);
    expect(found.some((name) => name.startsWith('Tdarr_Plugin_'))).toBe(false);
  });
});
