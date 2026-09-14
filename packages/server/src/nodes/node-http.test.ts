import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createNodeRepo, type NodeRepo } from '../db/node-repo.js';
import { createBundleStore, type BundleStore } from './bundles.js';
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
});
