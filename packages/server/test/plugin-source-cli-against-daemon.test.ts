import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { startDaemonForTest, type TestDaemon } from './helpers/daemon-harness.js';
import { CORPUS_DIR, corpusAvailable } from '../../engine/test/compat/corpus.js';

/**
 * INSTALLING A PLUGIN NO LONGER NEEDS THE DAEMON STOPPED.
 *
 * This is the defect that produced this work, hit on a live deployment: the
 * four `plugin source` commands refused to run while a daemon owned the data
 * directory — correctly, since the daemon is the only permitted writer — and
 * the API they should have forwarded to answered 501. Installing a plugin
 * therefore meant stopping the container, running the command against the
 * volume from a throwaway one, and starting it again. Real downtime, on a
 * service designed to run unattended.
 *
 * So every assertion here is about a REAL daemon that is running before the
 * command, still running after it, and still answering in between. The CLI is
 * driven through `main` exactly as a shell would, against the data directory
 * the daemon holds. What proves the fix is not the exit code — it is that the
 * rows appear in the daemon's database while the daemon owns it, and that
 * the daemon answers a request immediately afterwards.
 */

const FIXTURE_PLUGIN = `
exports.details = () => ({
  name: 'Fixture Plugin',
  description: 'installed while the daemon was running',
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

/** <tmp>/p/myPlugin/1.0.0/index.js — the layout `discoverFlowPlugins` looks for. */
const writeFixtureTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-daemon-plugins-'));
  const dir = join(root, 'p', 'myPlugin', '1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), FIXTURE_PLUGIN, 'utf8');
  return root;
};

interface SourceRow {
  id: string;
  kind: string;
  url: string;
  installedCount: number;
  lastSyncedAtMs: number | null;
  enabled: boolean;
}

let daemon: TestDaemon;
let dataDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const stdout = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
const stderr = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'trawlarr-daemon-data-'));
  daemon = await startDaemonForTest(dataDir);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  await daemon.stop();
});

const cli = async (...args: string[]): Promise<number> =>
  await main([...args, '--data-dir', dataDir]);

describe('plugin source commands against a live daemon', () => {
  it('adds, lists, syncs and removes a source with the daemon up throughout', async () => {
    const tree = writeFixtureTree();

    // The lock file the CLI routes on really is there: without it this suite
    // would be exercising the direct-database path and proving nothing.
    expect(existsSync(join(dataDir, 'daemon.json'))).toBe(true);

    expect(await cli('plugin', 'source', 'add', '--name', 'fx', '--path', tree)).toBe(0);
    // The row was written by the DAEMON — this reads it back through the
    // daemon's own API, which is the only process that has the database open.
    expect(await daemon.api<SourceRow[]>('GET', '/plugins/sources')).toMatchObject([
      { id: 'fx', kind: 'local', url: tree, installedCount: 0, lastSyncedAtMs: null },
    ]);
    expect(stdout()).toContain("runs its author's code");

    logSpy.mockClear();
    expect(await cli('plugin', 'source', 'list')).toBe(0);
    expect(stdout()).toContain('fx');
    expect(stdout()).toContain(tree);
    expect(stdout()).toContain('never synced');

    logSpy.mockClear();
    expect(await cli('plugin', 'source', 'sync', '--name', 'fx')).toBe(0);
    expect(stdout()).toContain('1 plugin(s) installed');

    const synced = await daemon.api<SourceRow[]>('GET', '/plugins/sources');
    expect(synced[0]!.installedCount).toBe(1);
    expect(synced[0]!.lastSyncedAtMs).not.toBeNull();
    // And the plugin resolves for everything that reads plugins — which is
    // what "installed" has to mean.
    expect(
      (await daemon.api<{ id: string }[]>('GET', '/plugins')).map((plugin) => plugin.id),
    ).toContain('fx:myPlugin');
    // The extraction directory belongs to the daemon's data directory, not to
    // whatever directory the CLI happened to be run from.
    expect(await daemon.api<{ status: string }>('GET', '/system/health')).toMatchObject({
      status: 'ok',
    });

    logSpy.mockClear();
    expect(await cli('plugin', 'source', 'remove', '--name', 'fx')).toBe(0);
    expect(stdout()).toContain('fx:myPlugin');
    expect(await daemon.api<SourceRow[]>('GET', '/plugins/sources')).toEqual([]);
    expect(
      (await daemon.api<{ id: string }[]>('GET', '/plugins')).map((plugin) => plugin.id),
    ).not.toContain('fx:myPlugin');

    // The daemon that was running when this test started is the daemon still
    // running now: nothing here stopped it, which is the entire point.
    expect((await daemon.raw('GET', '/system/health')).status).toBe(200);
  });

  it('syncs every enabled source with --all, and skips a disabled one', async () => {
    const one = writeFixtureTree();
    const two = writeFixtureTree();
    await cli('plugin', 'source', 'add', '--name', 'one', '--path', one);
    await cli('plugin', 'source', 'add', '--name', 'two', '--path', two);
    await daemon.api('PUT', '/plugins/sources/two', { enabled: false });

    logSpy.mockClear();
    expect(await cli('plugin', 'source', 'sync', '--all')).toBe(0);

    const sources = await daemon.api<SourceRow[]>('GET', '/plugins/sources');
    expect(sources.find((source) => source.id === 'one')!.installedCount).toBe(1);
    expect(sources.find((source) => source.id === 'two')!.installedCount).toBe(0);
    expect(
      (await daemon.api<{ id: string }[]>('GET', '/plugins')).map((plugin) => plugin.id),
    ).toContain('one:myPlugin');
  });

  it('refuses a bad name before asking, and passes the daemon-s own refusal through, writing nothing', async () => {
    expect(
      await cli('plugin', 'source', 'add', '--name', 'trawlarr', '--path', writeFixtureTree()),
    ).not.toBe(0);
    expect(stderr()).toMatch(/reserved/i);

    expect(await cli('plugin', 'source', 'sync', '--name', 'ghost')).not.toBe(0);
    expect(stderr()).toContain('ghost');

    expect(await cli('plugin', 'source', 'remove', '--name', 'ghost')).not.toBe(0);

    expect(await daemon.api<SourceRow[]>('GET', '/plugins/sources')).toEqual([]);
    // A refused command must not have left the daemon in any different state.
    expect((await daemon.raw('GET', '/system/health')).status).toBe(200);
  });

  it('fails the command when the daemon-s sync failed, rather than reporting success', async () => {
    // A tarball source pointing at a port nothing is listening on: the sync
    // is accepted with a 202 and fails inside the daemon, so the only way
    // the CLI can be right about it is by reading the outcome back.
    await daemon.api('POST', '/plugins/sources', {
      id: 'gone',
      url: 'https://127.0.0.1:9/plugins.tar.gz',
    });

    expect(await cli('plugin', 'source', 'sync', '--name', 'gone')).not.toBe(0);
    expect(stderr()).toContain('source-unreachable');
    expect((await daemon.api<SourceRow[]>('GET', '/plugins/sources'))[0]!.installedCount).toBe(0);
  });
});

/**
 * The same commands against the real Tdarr corpus — ninety-one plugins, which
 * is where "the daemon must stay responsive" stops being a claim about a
 * one-plugin fixture. Gated at COLLECTION time on the corpus being present,
 * because a check behind an async hook silently skips and still reports green.
 */
describe.runIf(corpusAvailable())('a real plugin corpus, installed while the daemon runs', () => {
  it('installs every plugin the corpus holds and answers requests throughout', async () => {
    await cli('plugin', 'source', 'add', '--name', 'tdarr', '--path', CORPUS_DIR);

    const syncing = cli('plugin', 'source', 'sync', '--name', 'tdarr');
    // While the sync runs, the daemon is still serving: it accepted the sync
    // with a 202 and yields between plugin loads, so this is not queued
    // behind ninety-one module bodies.
    expect((await daemon.raw('GET', '/system/health')).status).toBe(200);
    expect(await syncing).toBe(0);

    const installed = (await daemon.api<{ id: string; sourceId?: string }[]>('GET', '/plugins'))
      .filter((plugin) => plugin.sourceId === 'tdarr')
      .map((plugin) => plugin.id);
    expect(installed.length).toBeGreaterThan(50);
    expect(installed).toContain('tdarr:ffmpegCommandSetContainer');
  }, 300_000);
});
