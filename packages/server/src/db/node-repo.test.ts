import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE } from '@trawlarr/core';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createFlowRepo } from './flow-repo.js';
import { createLibraryRepo } from './library-repo.js';
import { createMediaFileRepo } from './media-file-repo.js';
import { createSettingsRepo } from './settings-repo.js';
import { ensureLocalNode } from '../api/routes/nodes.js';
import { createNodeRepo, NodeRepoError, type NodeRepo } from './node-repo.js';

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

  it('update validates the path map and schedule', async () => {
    const { node } = await repo.create({ name: 'n', nowMs: 0 });
    expect(() =>
      repo.update(node.id, { pathMap: [{ serverPath: 'rel', nodePath: '/x' }] }),
    ).toThrow();
    expect(
      repo.update(node.id, { pathMap: [{ serverPath: '/media/', nodePath: '/mnt' }] }).pathMap,
    ).toEqual([{ serverPath: '/media', nodePath: '/mnt' }]);
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
