import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCHEDULE } from '@trawlarr/core';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createFlowRepo } from './flow-repo.js';
import { createLibraryRepo } from './library-repo.js';
import { createMediaFileRepo } from './media-file-repo.js';
import { createSettingsRepo } from './settings-repo.js';
import { ensureLocalNode } from '../api/routes/nodes.js';
import { createNodeRepo, NodeRepoError, type NodeRepo } from './node-repo.js';
import { verifyPassword } from '../api/password.js';

// Counted, not replaced: every test still verifies with real argon2.
vi.mock('../api/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/password.js')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const NOW = 1_700_000_000_000;

let db: Db;
let repo: NodeRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createNodeRepo(db);
});

describe('createNodeRepo', () => {
  it('create returns a token once and stores only its hash', async () => {
    const { node, enrollToken } = await repo.create({ name: 'gpu-box', nowMs: 1000 });
    expect(enrollToken).toMatch(/^tnode_enroll_/);
    const raw = db
      .prepare('SELECT enroll_token_hash, secret_hash FROM node WHERE id = ?')
      .get(node.id) as Record<string, string | null>;
    expect(raw.enroll_token_hash).not.toContain(enrollToken);
    expect(raw.secret_hash).toBeNull();
    expect(node.enrolled).toBe(false);
  });

  it('enroll consumes the token exactly once', async () => {
    const { enrollToken, node } = await repo.create({ name: 'n', nowMs: 0 });
    const first = await repo.enroll({ token: enrollToken, nowMs: 1 });
    expect(first?.nodeId).toBe(node.id);
    expect(await repo.enroll({ token: enrollToken, nowMs: 2 })).toBeNull();
    expect(await repo.authenticate({ nodeId: node.id, secret: first!.secret })).toBe(true);
  });

  it('two concurrent enrolls with the same token yield exactly one usable secret', async () => {
    const { enrollToken, node } = await repo.create({ name: 'n', nowMs: 0 });
    const [first, second] = await Promise.all([
      repo.enroll({ token: enrollToken, nowMs: 1 }),
      repo.enroll({ token: enrollToken, nowMs: 1 }),
    ]);
    const results = [first, second].filter((r) => r !== null);
    expect(results).toHaveLength(1);
    const winner = results[0]!;
    expect(winner.nodeId).toBe(node.id);
    expect(await repo.authenticate({ nodeId: node.id, secret: winner.secret })).toBe(true);
  });

  it('an expired token does not enroll', async () => {
    const { enrollToken } = await repo.create({ name: 'n', nowMs: 0 });
    expect(await repo.enroll({ token: enrollToken, nowMs: 24 * 3_600_000 })).toBeNull();
  });

  it('a revoked node cannot authenticate even with the right secret', async () => {
    const { enrollToken, node } = await repo.create({ name: 'n', nowMs: 0 });
    const { secret } = (await repo.enroll({ token: enrollToken, nowMs: 1 }))!;
    repo.revoke(node.id, 5);
    expect(await repo.authenticate({ nodeId: node.id, secret })).toBe(false);
  });

  it('runs argon2 once for a secret it already verified, and never skips it for a wrong one', async () => {
    // A node fetches a plugin bundle one authenticated request per file. At
    // ~50 ms of argon2 each, the 626-file community corpus held a job's first
    // step for close to a minute while the daemon burned a core on it.
    const { enrollToken, node } = await repo.create({ name: 'n', nowMs: 0 });
    const { secret } = (await repo.enroll({ token: enrollToken, nowMs: 1 }))!;
    const verify = vi.mocked(verifyPassword);
    verify.mockClear();

    for (let i = 0; i < 5; i += 1) {
      expect(await repo.authenticate({ nodeId: node.id, secret })).toBe(true);
    }
    expect(verify).toHaveBeenCalledTimes(1);

    // A wrong secret still pays the full cost every time, and still fails.
    expect(await repo.authenticate({ nodeId: node.id, secret: `${secret}x` })).toBe(false);
    expect(await repo.authenticate({ nodeId: node.id, secret: `${secret}x` })).toBe(false);
    expect(verify).toHaveBeenCalledTimes(3);

    // And a revocation is honoured on the very next request, remembered or not.
    repo.revoke(node.id, 5);
    expect(await repo.authenticate({ nodeId: node.id, secret })).toBe(false);
  });

  it('does not let a remembered verification for one node authenticate another', async () => {
    const a = await repo.create({ name: 'a', nowMs: 0 });
    const b = await repo.create({ name: 'b', nowMs: 0 });
    const secretA = (await repo.enroll({ token: a.enrollToken, nowMs: 1 }))!.secret;
    const secretB = (await repo.enroll({ token: b.enrollToken, nowMs: 1 }))!.secret;
    expect(await repo.authenticate({ nodeId: a.node.id, secret: secretA })).toBe(true);
    // A's secret, remembered for A, opens nothing for B.
    expect(await repo.authenticate({ nodeId: b.node.id, secret: secretA })).toBe(false);
    expect(await repo.authenticate({ nodeId: b.node.id, secret: secretB })).toBe(true);
  });

  it('update validates the path map and schedule', async () => {
    const { node } = await repo.create({ name: 'n', nowMs: 0 });
    expect(() =>
      repo.update(node.id, { pathMap: [{ serverPath: 'rel', nodePath: '/x' }] }),
    ).toThrow();
    expect(
      repo.update(node.id, { pathMap: [{ serverPath: '/media/', nodePath: '/mnt' }] }).pathMap,
    ).toEqual([{ serverPath: '/media', nodePath: '/mnt' }]);
  });

  it('reads a stored map that no longer validates as-is, with the reason, and keeps it across other edits', async () => {
    const { node } = await repo.create({ name: 'n', nowMs: 0 });
    const legacy = [
      { serverPath: '/media', nodePath: '/mnt' },
      { serverPath: '/media/tv', nodePath: '/mnt/shows' },
    ];
    expect(() => repo.update(node.id, { pathMap: legacy })).toThrow(/"tv"[\s\S]*"shows"/);
    db.prepare('UPDATE node SET path_map_json = ? WHERE id = ?').run(
      JSON.stringify(legacy),
      node.id,
    );

    const stored = repo.getById(node.id)!;
    expect(stored.pathMap).toEqual(legacy);
    expect(stored.pathMapError).toMatch(/"tv"[\s\S]*"shows"/);
    expect(repo.list().find((record) => record.id === node.id)?.pathMapError).toBe(
      stored.pathMapError,
    );
    // Renaming the node must not be blocked by, or silently erase, the map.
    expect(repo.update(node.id, { name: 'renamed' }).pathMap).toEqual(legacy);
    // Fixing the map clears the reason.
    expect(
      repo.update(node.id, {
        pathMap: [
          { serverPath: '/media', nodePath: '/mnt' },
          { serverPath: '/media/tv', nodePath: '/mnt/tv' },
        ],
      }).pathMapError,
    ).toBeNull();
  });

  it('remove refuses a node with a running job', async () => {
    const { node } = await repo.create({ name: 'n', nowMs: 0 });

    const flow = createFlowRepo(db).create({
      name: 'HEVC',
      definition: {
        nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
        edges: [],
      },
      nowMs: NOW,
    });
    const library = createLibraryRepo(db).create({ name: 'Movies', roots: ['/media'], nowMs: NOW });
    const fileId = createMediaFileRepo(db).upsertScanned({
      libraryId: library.id,
      identity: { inodeKey: '1:2', contentKey: 'hash' },
      path: '/media/movie.mkv',
      nlink: 1,
      sizeBytes: 100,
      mtimeMs: NOW,
      ctimeMs: NOW,
      container: 'mkv',
      nowMs: NOW,
    });
    db.prepare(
      `INSERT INTO job (id, file_id, flow_id, flow_hash, node_id, state, started_at)
       VALUES ('job-1', ?, ?, ?, ?, 'running', ?)`,
    ).run(fileId, flow.id, flow.definitionHash, node.id, NOW);

    expect(() => repo.remove(node.id)).toThrow(NodeRepoError);
  });

  it('names must be unique and non-empty', async () => {
    await repo.create({ name: 'gpu-box', nowMs: 0 });
    await expect(repo.create({ name: 'gpu-box', nowMs: 1 })).rejects.toThrow(NodeRepoError);
    await expect(repo.create({ name: '', nowMs: 2 })).rejects.toThrow(NodeRepoError);
    await expect(repo.create({ name: 'local', nowMs: 3 })).rejects.toThrow(NodeRepoError);
  });

  it('the local node row still reads back', () => {
    const settings = createSettingsRepo({ db });
    ensureLocalNode({ db, settings, nowMs: () => NOW });
    const local = repo.getById('local');
    expect(local).not.toBeNull();
    expect(local?.enrolled).toBe(false);
    expect(local?.schedule).toEqual(DEFAULT_SCHEDULE);
  });
});
