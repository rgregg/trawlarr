import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFacts, type FactSet, type FlowDefinition } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase } from './db/connection.js';
import { createFlowRepo } from './db/flow-repo.js';
import { createLibraryRepo } from './db/library-repo.js';
import { createMediaFileRepo } from './db/media-file-repo.js';
import { migrate, SCHEMA_VERSION } from './db/migrate.js';
import { startDaemon, type Daemon } from './daemon/daemon.js';
import { DAEMON_LOCK_FILENAME, type DaemonRecord } from './daemon/lockfile.js';
import type { WatchHandle, WatchPort } from './daemon/watcher.js';
import {
  ApiRequestError,
  clientHost,
  createCliClient,
  daemonBaseUrl,
  DaemonUnreachableError,
} from './cli-client.js';
import { main } from './cli.js';

const NOW = Date.UTC(2024, 0, 1, 0, 30);

const RECORD: DaemonRecord = {
  pid: process.pid,
  bind: '127.0.0.1',
  port: 8265,
  apiKey: 'key-abc',
  startedAtMs: NOW,
  schemaVersion: SCHEMA_VERSION,
};

const PROBE: ProbeData = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '60.0', size: '4096', bit_rate: '16384' },
};
const FACTS: FactSet = extractFacts({ probe: PROBE, container: 'mkv', sizeBytes: 4096 });

const FLOW: FlowDefinition = {
  nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
};

const nullWatchPort: WatchPort = {
  watch: (): WatchHandle => ({ close: async (): Promise<void> => {} }),
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

const stdout = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
const stderr = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

const newDataDir = (): string => mkdtempSync(join(tmpdir(), 'trawlarr-client-'));

interface Seeded {
  dataDir: string;
  libraryId: string;
  fileId: string;
}

/**
 * A data directory holding one library whose flow row has been deleted, which
 * (the column being ON DELETE SET NULL) leaves it pointing at no flow at all
 * — a library that is about to be PAUSED, with a reason, by the first health
 * check that looks at it. That is the state `status` was blind to.
 */
const seed = (): Seeded => {
  const dataDir = newDataDir();
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-client-root-'));
  const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
  migrate(db);
  const flow = createFlowRepo(db).create({ name: 'Flow', definition: FLOW, nowMs: NOW });
  const library = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    flowId: flow.id,
    nowMs: NOW,
  });
  const mediaFileRepo = createMediaFileRepo(db);
  const fileId = mediaFileRepo.upsertScanned({
    libraryId: library.id,
    identity: { inodeKey: '2049:1000', contentKey: '4096:1:ff' },
    path: join(root, 'file.mkv'),
    nlink: 1,
    sizeBytes: 4096,
    mtimeMs: NOW,
    ctimeMs: NOW,
    container: 'mkv',
    nowMs: NOW,
  });
  mediaFileRepo.setProbe({ fileId, probe: PROBE, facts: FACTS });
  mediaFileRepo.setState({ fileId, state: 'failed' });
  db.prepare(`DELETE FROM flow WHERE id = ?`).run(flow.id);
  db.close();
  return { dataDir, libraryId: library.id, fileId };
};

interface Call {
  method: string;
  path: string;
}

interface Recorder {
  calls: Call[];
  port: number;
  close: () => Promise<void>;
}

/**
 * A listener that records `{method, path}` and forwards everything to the
 * real daemon.
 *
 * This is the ONLY way to prove which transport the CLI chose: no assertion
 * on its output can distinguish a `status` served over HTTP from the same
 * `status` read straight out of the database, and "it printed the right
 * thing" is exactly what a CLI that quietly opened the database behind the
 * daemon's back would also do.
 */
const recordApiCalls = async (upstreamPort?: number): Promise<Recorder> => {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    calls.push({ method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0]! });
    if (upstreamPort === undefined) {
      res.writeHead(502).end();
      return;
    }
    const proxied = httpRequest(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 500, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxied.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(proxied);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    calls,
    port,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

/** Point the data directory's lock file at the recorder, keeping this live pid. */
const routeThroughRecorder = (dataDir: string, port: number): void => {
  const path = join(dataDir, DAEMON_LOCK_FILENAME);
  const record = JSON.parse(readFileSync(path, 'utf8')) as DaemonRecord;
  writeFileSync(path, JSON.stringify({ ...record, port }), 'utf8');
};

const daemons: Daemon[] = [];
const recorders: Recorder[] = [];

const startDaemonFor = async (dataDir: string): Promise<Daemon> => {
  const daemon = await startDaemon({
    dataDir,
    port: 0,
    installSignalHandlers: false,
    watchPort: nullWatchPort,
    drainDeadlineMs: 0,
    onError: () => {},
  });
  daemons.push(daemon);
  return daemon;
};

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.stop();
  while (recorders.length > 0) await recorders.pop()!.close();
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('createCliClient', () => {
  it('dials the port and key the lock file recorded, on the versioned prefix', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const client = createCliClient(RECORD, {
      fetchFn: async (url, init) => {
        seen.push({ url, headers: init.headers });
        return new Response(JSON.stringify([{ id: 'l1' }]), { status: 200 });
      },
    });

    await expect(client.get('/libraries')).resolves.toEqual([{ id: 'l1' }]);
    expect(seen[0]!.url).toBe('http://127.0.0.1:8265/api/v1/libraries');
    expect(seen[0]!.headers['x-api-key']).toBe('key-abc');
  });

  it('surfaces the daemon own error message, with its status', async () => {
    const client = createCliClient(RECORD, {
      fetchFn: async () =>
        new Response(
          JSON.stringify({ error: { code: 'flow-invalid', message: 'that flow cannot run' } }),
          { status: 400 },
        ),
    });

    const error = await client.post('/flows', {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(400);
    expect((error as ApiRequestError).code).toBe('flow-invalid');
    // Verbatim: the daemon wrote that sentence for this reader.
    expect((error as ApiRequestError).message).toBe('that flow cannot run');
  });

  it('reports a non-JSON error body rather than swallowing it', async () => {
    const client = createCliClient(RECORD, {
      fetchFn: async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    });
    await expect(client.get('/libraries')).rejects.toThrow(/502 Bad Gateway/);
  });

  it('accepts an empty body (204) instead of failing to parse it', async () => {
    const client = createCliClient(RECORD, {
      fetchFn: async () => new Response(null, { status: 204 }),
    });
    await expect(client.delete('/libraries/l1')).resolves.toBeUndefined();
  });

  it('names the daemon when nothing answers, rather than failing obscurely', async () => {
    const client = createCliClient(RECORD, {
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const error = await client.get('/libraries').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DaemonUnreachableError);
    expect((error as Error).message).toContain(String(process.pid));
  });

  it('dials loopback for a daemon bound to every interface', () => {
    // "0.0.0.0" is not an address anything can connect TO.
    expect(clientHost('0.0.0.0')).toBe('127.0.0.1');
    expect(clientHost('::')).toBe('::1');
    expect(clientHost('192.168.1.5')).toBe('192.168.1.5');
    expect(daemonBaseUrl({ ...RECORD, bind: '::1' })).toBe('http://[::1]:8265/api/v1');
  });
});

describe('cli routing', () => {
  it('routes a CLI command through the API when a daemon owns the data directory', async () => {
    const { dataDir } = seed();
    const daemon = await startDaemonFor(dataDir);
    const recorder = await recordApiCalls(daemon.port);
    recorders.push(recorder);
    routeThroughRecorder(dataDir, recorder.port);

    expect(await main(['status', '--data-dir', dataDir])).toBe(0);

    // The proof: the daemon served it. No assertion on the printed text
    // could tell this apart from the CLI opening the database itself.
    expect(recorder.calls.map((call) => call.path)).toContain('/api/v1/libraries');
    expect(recorder.calls.every((call) => call.path.startsWith('/api/v1/'))).toBe(true);
  });

  it('opens the database directly when no daemon is running', async () => {
    const { dataDir } = seed();
    const recorder = await recordApiCalls();
    recorders.push(recorder);

    expect(await main(['status', '--data-dir', dataDir])).toBe(0);
    expect(recorder.calls).toHaveLength(0);
    expect(stdout()).toContain('Movies');
  });

  it('prints the same status whether or not a daemon is serving it', async () => {
    const { dataDir } = seed();
    const daemon = await startDaemonFor(dataDir);
    expect(await main(['status', '--data-dir', dataDir, '--files'])).toBe(0);
    const viaDaemon = stdout();

    await daemons.pop()!.stop();
    void daemon;
    logSpy.mockClear();

    expect(await main(['status', '--data-dir', dataDir, '--files'])).toBe(0);
    // A status that reads differently depending on whether a daemon happens
    // to be up is a bug report waiting to be filed.
    expect(stdout()).toBe(viaDaemon);
  });

  it('shows why a library is paused, in the words the API uses', async () => {
    const { dataDir } = seed();
    await startDaemonFor(dataDir);

    expect(await main(['status', '--data-dir', dataDir])).toBe(0);
    // The gap this closes: `paused_reason` was written, and exposed by the
    // API, and invisible from the one command an operator runs.
    expect(stdout()).toContain('PAUSED:');
    expect(stdout()).toContain('no flow attached');
    expect(stdout()).toContain('nothing in this library converges');
  });

  it('refuses "run" while a daemon owns the queue, naming its pid', async () => {
    const { dataDir } = seed();
    const daemon = await startDaemonFor(dataDir);

    expect(await main(['run', '--data-dir', dataDir])).toBe(1);
    expect(stderr()).toContain(String(process.pid));
    expect(stderr()).toContain('The daemon is already draining it');
    // And it really did not claim anything: the daemon is still the only
    // thing that has ever opened that database.
    expect(daemon.port).toBeGreaterThan(0);
  });

  it('serves maintenance commands through the daemon rather than refusing them', async () => {
    const { dataDir } = seed();
    const daemon = await startDaemonFor(dataDir);
    const recorder = await recordApiCalls(daemon.port);
    recorders.push(recorder);
    routeThroughRecorder(dataDir, recorder.port);

    expect(await main(['reap', '--data-dir', dataDir])).toBe(0);
    expect(await main(['trash', 'purge', '--data-dir', dataDir, '--dry-run'])).toBe(0);
    expect(await main(['forget', '--missing', '--data-dir', dataDir, '--dry-run'])).toBe(0);

    const paths = recorder.calls.map((call) => call.path);
    expect(paths).toContain('/api/v1/system/maintenance/reap');
    expect(paths).toContain('/api/v1/system/maintenance/trash-purge');
    expect(paths).toContain('/api/v1/system/maintenance/forget');
  });

  it('requeues through the daemon, and the requeue really happened', async () => {
    const seeded = seed();
    const daemon = await startDaemonFor(seeded.dataDir);

    expect(await main(['requeue', '--file', seeded.fileId, '--data-dir', seeded.dataDir])).toBe(0);
    expect(stdout()).toContain('failed -> queued');

    // Observable state, in the daemon's own database, read back over the
    // API it owns — never a second connection to the file it has open.
    const file = await fetch(
      `http://127.0.0.1:${String(daemon.port)}/api/v1/files/${seeded.fileId}`,
      { headers: { 'x-api-key': daemon.apiKey } },
    );
    const body = (await file.json()) as { file: { state: string } };
    expect(body.file.state).toBe('queued');
  });

  it('adds a library through the daemon, and the daemon knows about it immediately', async () => {
    const { dataDir } = seed();
    const daemon = await startDaemonFor(dataDir);
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-client-new-root-'));

    expect(
      await main(['library', 'add', '--name', 'Shows', '--root', root, '--data-dir', dataDir]),
    ).toBe(0);

    const response = await fetch(`http://127.0.0.1:${String(daemon.port)}/api/v1/libraries`, {
      headers: { 'x-api-key': daemon.apiKey },
    });
    const libraries = (await response.json()) as { name: string }[];
    expect(libraries.map((library) => library.name)).toContain('Shows');
  });

  it('reports a duplicate library name in its own words, daemon or not', async () => {
    const { dataDir } = seed();
    await startDaemonFor(dataDir);
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-client-dup-'));

    expect(
      await main(['library', 'add', '--name', 'Movies', '--root', root, '--data-dir', dataDir]),
    ).toBe(1);
    expect(stderr()).toContain('a library named "Movies" already exists');
  });

  it('says a scan was handed to the daemon rather than pretending to have walked it', async () => {
    const { dataDir } = seed();
    // A library with a flow: `scan` refuses one without, daemon or not.
    const daemon = await startDaemonFor(dataDir);
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-client-scan-'));
    await main(['library', 'add', '--name', 'Shows', '--root', root, '--data-dir', dataDir]);
    logSpy.mockClear();

    expect(await main(['scan', '--library', 'Shows', '--data-dir', dataDir])).toBe(1);
    expect(stderr()).toContain('has no flow attached');
    expect(daemon.port).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// plugin commands, behind a live daemon
// ---------------------------------------------------------------------------

/** The `<name>/<version>/index.js` layout a plugin source is discovered by. */
const writePluginTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-client-plugins-'));
  const dir = join(root, 'p', 'myPlugin', '1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.js'),
    `
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
`,
    'utf8',
  );
  return root;
};

describe('cli routing: plugin', () => {
  it('lists plugins through the daemon rather than opening the database', async () => {
    const { dataDir } = seed();
    // Installed BEFORE the daemon starts, which is the only way to install
    // anything in this build — see the source commands below.
    await main(['plugin', 'source', 'add', '--name', 'fx', '--path', writePluginTree(), '--data-dir', dataDir]); // prettier-ignore
    await main(['plugin', 'source', 'sync', '--name', 'fx', '--data-dir', dataDir]);

    const daemon = await startDaemonFor(dataDir);
    const recorder = await recordApiCalls(daemon.port);
    recorders.push(recorder);
    routeThroughRecorder(dataDir, recorder.port);
    logSpy.mockClear();

    expect(await main(['plugin', 'list', '--data-dir', dataDir])).toBe(0);
    // The proof of transport: no assertion on the text could tell this from
    // the CLI opening the database the daemon holds.
    expect(recorder.calls.map((call) => call.path)).toContain('/api/v1/plugins');
    expect(stdout()).toContain('fx:myPlugin');
    expect(stdout()).toContain('trawlarr:execute');
  });

  it('shows one plugin through the daemon, id-encoded for the path', async () => {
    const { dataDir } = seed();
    const daemon = await startDaemonFor(dataDir);
    const recorder = await recordApiCalls(daemon.port);
    recorders.push(recorder);
    routeThroughRecorder(dataDir, recorder.port);
    logSpy.mockClear();

    expect(await main(['plugin', 'show', '--id', 'trawlarr:execute', '--data-dir', dataDir])).toBe(0); // prettier-ignore
    expect(recorder.calls.map((call) => call.path)).toContain('/api/v1/plugins/trawlarr%3Aexecute');
    expect(stdout()).toContain('Outputs (');
  });

  it('refuses every plugin-source command while a daemon owns the directory, saying why', async () => {
    const { dataDir } = seed();
    await startDaemonFor(dataDir);
    const tree = writePluginTree();

    for (const argv of [
      ['plugin', 'source', 'add', '--name', 'fx2', '--path', tree],
      ['plugin', 'source', 'list'],
      ['plugin', 'source', 'sync', '--all'],
      ['plugin', 'source', 'remove', '--name', 'fx2'],
    ]) {
      errorSpy.mockClear();
      expect(await main([...argv, '--data-dir', dataDir])).toBe(1);
      // Named, not obscure: the pid that owns the directory, and the fact
      // that the API has no route to forward this to yet.
      expect(stderr()).toContain(String(process.pid));
      expect(stderr()).toContain('/api/v1/plugins/sources answers 501');
      expect(stderr()).toContain('Stop the daemon');
    }

    // And it really did not write: no source row appeared behind the daemon.
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_source').get()).toEqual({ n: 0 });
    db.close();
  });
});
