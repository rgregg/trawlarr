import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../daemon/events.js';
import type { ScanCoordinator } from '../daemon/scan-coordinator.js';
import type { Supervisor } from '../daemon/supervisor.js';
import type { PluginSyncCoordinator } from '../plugins/sync-coordinator.js';
import type { FlowDryRunCoordinator } from '../flow/dry-run-runs.js';
import type { AccountRepo } from '../db/account-repo.js';
import type { SettingsRepo } from '../db/settings-repo.js';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createNodeRepo, type NodeRepo } from '../db/node-repo.js';
import type { ApiContext } from '../api/router.js';
import { createApiHandler } from '../api/server.js';
import { createBundleStore, type BundleStore } from './bundles.js';
import { createNoopNodeHub } from './hub.js';
import { createNodeHttpHandler } from './node-http.js';

const NOW = 1_700_000_000_000;

let db: Db;
let nodeRepo: NodeRepo;
let bundles: BundleStore;
let bundleDir: string;
let server: Server;
let baseUrl: string;

/**
 * Wraps the handler under test in a real `http.Server`, the way the task
 * brief asks: proving the streaming/auth/404 paths against a real socket,
 * not a handler called directly. A request the handler resolves `false` for
 * gets this sentinel status, so "wrote nothing" is distinguishable from
 * "wrote a 404 of its own".
 */
const UNHANDLED_STATUS = 599;

beforeEach(async () => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  nodeRepo = createNodeRepo(db);
  bundles = createBundleStore();

  bundleDir = await mkdtemp(join(tmpdir(), 'trawlarr-bundle-'));
  await writeFile(join(bundleDir, 'plugin.js'), 'module.exports = {};');
  await mkdir(join(bundleDir, 'sub'));
  await writeFile(join(bundleDir, 'sub', 'helper.js'), '// helper');

  const handler = createNodeHttpHandler({ nodes: nodeRepo, bundles, nowMs: () => NOW });
  server = createServer((req, res) => {
    void (async () => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(UNHANDLED_STATUS, { 'content-type': 'text/plain' });
        res.end('unhandled');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

const enrollViaHttp = async (token: string): Promise<Response> =>
  await fetch(`${baseUrl}/api/v1/nodes/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

/** Creates a node and enrolls it over the real handler, returning its live credential. */
const enrollFreshNode = async (): Promise<{ nodeId: string; secret: string }> => {
  const { enrollToken } = await nodeRepo.create({ name: `remote-${randomUUID()}`, nowMs: NOW });
  const response = await enrollViaHttp(enrollToken);
  return (await response.json()) as { nodeId: string; secret: string };
};

describe('createNodeHttpHandler', () => {
  it('enrolls with a valid token, and refuses the same token a second time', async () => {
    const { enrollToken } = await nodeRepo.create({ name: 'remote-1', nowMs: NOW });

    const first = await enrollViaHttp(enrollToken);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { nodeId: string; secret: string };
    expect(typeof body.nodeId).toBe('string');
    expect(typeof body.secret).toBe('string');

    const second = await enrollViaHttp(enrollToken);
    expect(second.status).toBe(401);
    expect((await second.json()) as { error: string }).toMatchObject({
      error: 'enrollment_refused',
    });
  });

  it('refuses a bundle manifest with no headers or a wrong secret, and serves it with the right one', async () => {
    const { nodeId, secret } = await enrollFreshNode();
    const { hash, manifest } = await bundles.manifestFor(bundleDir);

    const noHeaders = await fetch(`${baseUrl}/api/v1/nodes/bundles/${hash}`);
    expect(noHeaders.status).toBe(401);

    const wrongSecret = await fetch(`${baseUrl}/api/v1/nodes/bundles/${hash}`, {
      headers: { 'x-trawlarr-node': nodeId, authorization: 'Bearer wrong-secret' },
    });
    expect(wrongSecret.status).toBe(401);

    const ok = await fetch(`${baseUrl}/api/v1/nodes/bundles/${hash}`, {
      headers: { 'x-trawlarr-node': nodeId, authorization: `Bearer ${secret}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(manifest);
  });

  it('streams a listed bundle file, and 404s a traversal attempt or an unlisted file', async () => {
    const { nodeId, secret } = await enrollFreshNode();
    const { hash } = await bundles.manifestFor(bundleDir);
    const authHeaders = { 'x-trawlarr-node': nodeId, authorization: `Bearer ${secret}` };

    const file = await fetch(`${baseUrl}/api/v1/nodes/bundles/${hash}/files/sub/helper.js`, {
      headers: authHeaders,
    });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(await file.text()).toBe('// helper');

    const traversal = await fetch(
      `${baseUrl}/api/v1/nodes/bundles/${hash}/files/..%2F..%2Fetc%2Fpasswd`,
      { headers: authHeaders },
    );
    expect(traversal.status).toBe(404);

    const unlisted = await fetch(`${baseUrl}/api/v1/nodes/bundles/${hash}/files/nope.js`, {
      headers: authHeaders,
    });
    expect(unlisted.status).toBe(404);
  });

  it("refuses a revoked node's secret", async () => {
    const { nodeId, secret } = await enrollFreshNode();
    nodeRepo.revoke(nodeId, NOW);
    const { hash } = await bundles.manifestFor(bundleDir);

    const response = await fetch(`${baseUrl}/api/v1/nodes/bundles/${hash}`, {
      headers: { 'x-trawlarr-node': nodeId, authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(401);
  });

  it('resolves false and writes nothing for a request to a non-node path', async () => {
    const response = await fetch(`${baseUrl}/api/v1/libraries`);
    expect(response.status).toBe(UNHANDLED_STATUS);
  });

  it('404s a manifest requested under a hash the tree has since moved on from', async () => {
    const { nodeId, secret } = await enrollFreshNode();
    const authHeaders = { 'x-trawlarr-node': nodeId, authorization: `Bearer ${secret}` };
    const { hash: oldHash } = await bundles.manifestFor(bundleDir);

    await writeFile(join(bundleDir, 'plugin.js'), 'module.exports = { changed: true };');
    const { hash: newHash } = await bundles.manifestFor(bundleDir);
    expect(newHash).not.toBe(oldHash);

    const stale = await fetch(`${baseUrl}/api/v1/nodes/bundles/${oldHash}`, {
      headers: authHeaders,
    });
    expect(stale.status).toBe(404);

    // The daemon is still healthy, and the CURRENT hash still resolves.
    const fresh = await fetch(`${baseUrl}/api/v1/nodes/bundles/${newHash}`, {
      headers: authHeaders,
    });
    expect(fresh.status).toBe(200);
  });

  it('404s an oversized enroll body with the fixed refusal, rather than resetting the connection', async () => {
    const oversized = JSON.stringify({ token: 'x'.repeat(1024 * 1024) });

    const response = await enrollViaHttp(oversized);

    expect(response.status).toBe(401);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'enrollment_refused',
    });
  });

  /**
   * The manifest still lists this file — it just cannot be read any more.
   * Before the fix, this raced a `writeHead(200)` in ahead of the read
   * actually failing, so the client got a "successful" 200 whose body
   * never arrived; now the file's `open` never fires, so a clean 404 goes
   * out instead.
   */
  it('404s a bundle file that vanished after the manifest was built, and keeps serving', async () => {
    const { nodeId, secret } = await enrollFreshNode();
    const authHeaders = { 'x-trawlarr-node': nodeId, authorization: `Bearer ${secret}` };
    const { hash } = await bundles.manifestFor(bundleDir);

    await rm(join(bundleDir, 'sub', 'helper.js'));

    const response = await fetch(`${baseUrl}/api/v1/nodes/bundles/${hash}/files/sub/helper.js`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(404);

    // The server is still alive and answers a completely unrelated request.
    const stillAlive = await fetch(`${baseUrl}/api/v1/nodes/bundles/${hash}/files/plugin.js`, {
      headers: authHeaders,
    });
    expect(stillAlive.status).toBe(200);
  });
});

/**
 * These prove the fix for the daemon-crashing defect: `nodeHttp` is awaited
 * INSIDE `createApiHandler`'s own try/catch (server.ts), so nothing it does
 * — a client aborting mid-body, a read-stream error — can become an
 * unhandled rejection that takes the whole process down. Exercised through
 * `createApiHandler` itself, not the bare handler, because that wrapping is
 * exactly what changed.
 */
describe('mounted through createApiHandler', () => {
  let ctx: ApiContext;
  let mountedServer: Server;
  let mountedUrl: string;

  const stubSettings = (): SettingsRepo =>
    ({
      getDaemon: () => ({ bind: '127.0.0.1', port: 0, apiKey: 'the-operator-api-key-000000' }),
    }) as unknown as SettingsRepo;

  beforeEach(async () => {
    ctx = {
      db: {} as Db,
      settings: stubSettings(),
      bus: createEventBus(),
      supervisor: {} as Supervisor,
      scans: {} as ScanCoordinator,
      accounts: {} as AccountRepo,
      pluginSyncs: {} as PluginSyncCoordinator,
      dryRuns: {} as FlowDryRunCoordinator,
      dataDir: '/nonexistent-data-dir',
      nowMs: () => NOW,
      version: '0.0.0-test',
      commit: null,
      schemaVersion: 1,
      envApplications: [],
      hardwareFindings: [],
      nodes: createNoopNodeHub(),
    };
    const nodeHttp = createNodeHttpHandler({ nodes: nodeRepo, bundles, nowMs: () => NOW });
    mountedServer = createServer(
      createApiHandler(ctx, { nodeHttp, webRoot: null, onError: () => {} }),
    );
    await new Promise<void>((resolve) => mountedServer.listen(0, '127.0.0.1', resolve));
    mountedUrl = `http://127.0.0.1:${(mountedServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mountedServer.close(() => resolve()));
  });

  it('runs nodeHttp before the router, so the operator API key does not authenticate a bundle request', async () => {
    const { nodeId } = await enrollFreshNode();
    const { hash } = await bundles.manifestFor(bundleDir);

    // Valid operator credential -- but this is a NODE-facing path, which
    // nodeHttp claims before the router (and its API-key check) ever runs.
    const response = await fetch(`${mountedUrl}/api/v1/nodes/bundles/${hash}`, {
      headers: { 'x-api-key': 'the-operator-api-key-000000', 'x-trawlarr-node': nodeId },
    });

    expect(response.status).toBe(401);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'unauthorized' },
    });
  });

  it('survives a client aborting an enroll body mid-write, and keeps answering afterwards', async () => {
    const port = (mountedServer.address() as AddressInfo).port;
    const body = JSON.stringify({ token: 'a'.repeat(200) });

    await new Promise<void>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        const head =
          `POST /api/v1/nodes/enroll HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${String(body.length)}\r\n` +
          `Connection: close\r\n\r\n`;
        // Only the head plus HALF the declared body, then the socket is cut
        // — the server is left mid-`readCappedBody` with no 'end' coming.
        socket.write(head + body.slice(0, Math.floor(body.length / 2)), () => {
          socket.destroy();
          resolve();
        });
      });
      socket.on('error', () => resolve());
    });

    // Give the aborted request's handler a turn to run (and, before the
    // fix, to throw an unhandled rejection that would kill the process
    // before this next request ever got a chance to prove anything).
    await new Promise((resolve) => setTimeout(resolve, 50));

    // `GET /system/health` is the one anonymous route, needing only
    // `ctx.version`/`ctx.schemaVersion` -- both present on the stub -- so a
    // 200 here proves the process is still alive and still routing
    // ordinary requests through `createApiHandler` after the abort.
    const health = await fetch(`${mountedUrl}/api/v1/system/health`);
    expect(health.status).toBe(200);
  });
});
