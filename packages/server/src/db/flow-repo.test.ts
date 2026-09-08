import { beforeEach, describe, expect, it } from 'vitest';
import { flowDefinitionHash, type FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createFlowRepo, FlowChangedError, type FlowRepo } from './flow-repo.js';
import { createFlowVersionRepo } from './flow-version-repo.js';

const NOW = 1_700_000_000_000;

const definition = (encoder = 'libx265'): FlowDefinition => ({
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'enc',
      pluginId: 'trawlarr:setVideoEncoder',
      pluginVersion: '1.0.0',
      inputs: { encoder, quality: '24' },
    },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'enc' }],
});

// A definition `assertFlowDefinitionValid` genuinely rejects: two nodes
// sharing the id "dup" trips the `duplicate-node-id` check (the executor
// indexes nodes by id, so a duplicate would silently drop one of them).
const DEF = definition();
const OTHER_DEF = definition('libx264');
const INVALID_DEF: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'dup', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
    { id: 'dup', pluginId: 'trawlarr:verifyOutput', pluginVersion: '1.0.0', inputs: {} },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'dup' }],
};

const seed = (): { db: Db; repo: FlowRepo } => {
  const seededDb = openDatabase({ file: ':memory:' });
  migrate(seededDb);
  return { db: seededDb, repo: createFlowRepo(seededDb) };
};

let db: Db;
let repo: FlowRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createFlowRepo(db);
});

describe('createFlowRepo', () => {
  it('persists positions without changing the flow, draft, timestamps, hash, or version history', () => {
    const flow = repo.create({ name: 'Layout', definition: DEF, nowMs: NOW });
    repo.saveDraft({
      id: flow.id,
      draft: INVALID_DEF,
      baseHash: flow.definitionHash,
      nowMs: NOW + 1,
    });
    const before = repo.getById(flow.id);
    const versions = createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 });
    const layout = { start: { x: 10, y: 200 }, newDraftNode: { x: -100, y: 20 } };
    expect(repo.saveLayout(flow.id, layout)).toEqual(layout);
    expect(createFlowRepo(db).getById(flow.id)).toEqual({ ...before, layout });
    expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 })).toEqual(
      versions,
    );
    expect(repo.list()[0]?.layout).toEqual(layout);
    expect(repo.getByName('Layout')?.layout).toEqual(layout);
    expect(() => repo.saveLayout('missing', layout)).toThrow('Unknown flow');
  });

  it('keeps layout independent of publishing and discarding drafts', () => {
    const flow = repo.create({ name: 'Layout', definition: DEF, nowMs: NOW });
    const layout = { start: { x: 500, y: 200 } };
    repo.saveLayout(flow.id, layout);
    repo.saveDraft({
      id: flow.id,
      draft: OTHER_DEF,
      baseHash: flow.definitionHash,
      nowMs: NOW + 1,
    });
    repo.clearDraft(flow.id);
    expect(repo.getById(flow.id)?.layout).toEqual(layout);
    const published = repo.update({ id: flow.id, definition: OTHER_DEF, nowMs: NOW + 2 });
    expect(published.layout).toEqual(layout);
    expect(published.definitionHash).toBe(flowDefinitionHash(OTHER_DEF));
    repo.saveLayout(flow.id, {});
    expect(repo.getById(flow.id)).toEqual({ ...published, layout: {} });
  });

  it('stores the definition and its hash together', () => {
    const created = repo.create({ name: 'HEVC', definition: definition(), nowMs: NOW });
    expect(created.definitionHash).toBe(flowDefinitionHash(definition()));
    expect(repo.getById(created.id)).toEqual(created);
  });

  it('round-trips the definition structurally', () => {
    const created = repo.create({ name: 'HEVC', definition: definition(), nowMs: NOW });
    expect(created.definition).toEqual(definition());
  });

  it('recomputes the hash on update, so editing a flow changes its identity', () => {
    const created = repo.create({ name: 'HEVC', definition: definition(), nowMs: NOW });
    const updated = repo.update({
      id: created.id,
      definition: definition('libx264'),
      nowMs: NOW + 1,
    });
    expect(updated.definitionHash).not.toBe(created.definitionHash);
    expect(updated.definitionHash).toBe(flowDefinitionHash(definition('libx264')));
    expect(updated.updatedAt).toBe(NOW + 1);
  });

  it('finds a flow by name and lists them', () => {
    const a = repo.create({ name: 'HEVC', definition: definition(), nowMs: NOW });
    repo.create({ name: 'Remux', definition: definition(), nowMs: NOW });
    expect(repo.getByName('HEVC')?.id).toBe(a.id);
    expect(repo.list()).toHaveLength(2);
  });

  it('returns null for a flow that does not exist', () => {
    expect(repo.getById('nope')).toBeNull();
    expect(repo.getByName('nope')).toBeNull();
  });

  it('rejects updating a flow that does not exist', () => {
    expect(() => repo.update({ id: 'nope', definition: definition(), nowMs: NOW })).toThrow(/nope/);
  });
});

/**
 * Creation and update are the only two ways a definition enters the database,
 * so they are where validation belongs: a stored flow is a flow the executor
 * has agreed to run. Rejected, never repaired — a repaired flow is a flow the
 * author did not write, running unattended over their library.
 */
describe('createFlowRepo: validation', () => {
  const broken = (): FlowDefinition => ({
    nodes: [
      { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
      { id: 'dup', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
      { id: 'dup', pluginId: 'trawlarr:verifyOutput', pluginVersion: '1.0.0', inputs: {} },
    ],
    edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'dup' }],
  });

  it('refuses to create a flow with a duplicate node id, and stores nothing', () => {
    expect(() => repo.create({ name: 'Broken', definition: broken(), nowMs: NOW })).toThrow(/dup/);
    expect(repo.getByName('Broken')).toBeNull();
    expect(repo.list()).toHaveLength(0);
  });

  it('refuses to update a valid flow into an invalid one, leaving the stored definition intact', () => {
    const created = repo.create({ name: 'HEVC', definition: definition(), nowMs: NOW });
    expect(() => repo.update({ id: created.id, definition: broken(), nowMs: NOW + 1 })).toThrow(
      /dup/,
    );
    const reread = repo.getById(created.id)!;
    expect(reread.definition).toEqual(definition());
    expect(reread.definitionHash).toBe(created.definitionHash);
    expect(reread.updatedAt).toBe(NOW);
  });

  it('refuses an edge naming an output the node does not declare', () => {
    const definitionWithBadOutput: FlowDefinition = {
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
        { id: 'enc', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
      ],
      edges: [{ fromNodeId: 'start', outputNumber: 2, toNodeId: 'enc' }],
    };
    expect(() =>
      repo.create({ name: 'BadOutput', definition: definitionWithBadOutput, nowMs: NOW }),
    ).toThrow(/output 2/);
  });

  it('accepts a flow whose plugin ids this host cannot resolve, checking only its structure', () => {
    const community: FlowDefinition = {
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
        { id: 'x', pluginId: '/plugins/not-installed-here.js', pluginVersion: '1.0.0', inputs: {} },
      ],
      edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'x' }],
    };
    expect(() =>
      repo.create({ name: 'Community', definition: community, nowMs: NOW }),
    ).not.toThrow();
  });

  it('leaves an already-stored invalid flow readable, so a live database keeps working', () => {
    // Written the way a pre-validation release wrote it: straight into the
    // table. Nothing revalidates on read, so the flow keeps running exactly
    // as it did before this check existed.
    db.prepare(
      `INSERT INTO flow (id, name, description, tags, definition_json, definition_hash,
                         created_at, updated_at)
       VALUES ('legacy', 'Legacy', '', '', ?, 'hash', ?, ?)`,
    ).run(JSON.stringify(broken()), NOW, NOW);

    const legacy = repo.getByName('Legacy');
    expect(legacy?.definition.nodes).toHaveLength(3);
    expect(repo.list()).toHaveLength(1);
  });
});

/**
 * Every publish is also a ledger entry, appended in the same transaction as
 * the definition write: a live definition whose newest version disagreed
 * with it would make the history lie about what actually ran.
 */
describe('createFlowRepo: version history', () => {
  it('records a version for a newly created flow', () => {
    const { db, repo } = seed();
    const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });

    const versions = createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 });
    expect(versions.total).toBe(1);
    expect(versions.items[0]!.definitionHash).toBe(flow.definitionHash);
  });

  describe('createFlowRepo: drafts', () => {
    it('stores invalid work without changing the live definition, timestamps or history', () => {
      const flow = repo.create({ name: 'Draft', definition: DEF, nowMs: NOW });
      expect(flow).toMatchObject({ draft: null, draftBaseHash: null, draftUpdatedAt: null });
      const versions = createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 });

      const saved = repo.saveDraft({
        id: flow.id,
        draft: INVALID_DEF,
        baseHash: flow.definitionHash,
        nowMs: NOW + 1,
      });

      expect(saved).toEqual({
        ...flow,
        draft: INVALID_DEF,
        draftBaseHash: flow.definitionHash,
        draftUpdatedAt: NOW + 1,
      });
      expect(repo.getById(flow.id)).toEqual(saved);
      expect(repo.getByName(flow.name)).toEqual(saved);
      expect(repo.list()).toEqual([saved]);
      expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 })).toEqual(
        versions,
      );
    });

    it('saves an empty graph and permits retaining a stale base hash', () => {
      const flow = repo.create({ name: 'Draft', definition: DEF, nowMs: NOW });
      const saved = repo.saveDraft({
        id: flow.id,
        draft: { nodes: [], edges: [] },
        baseHash: 'earlier-hash',
        nowMs: NOW + 1,
      });
      expect(saved.draft).toEqual({ nodes: [], edges: [] });
      expect(saved.draftBaseHash).toBe('earlier-hash');
    });

    it.each([
      {},
      { nodes: [null], edges: [] },
      { nodes: DEF.nodes, edges: [{ fromNodeId: 'start', toNodeId: 'enc', outputNumber: '1' }] },
      { nodes: [{ ...DEF.nodes[0], inputs: [] }], edges: [] },
    ])('rejects a malformed draft without replacing saved work: %j', (malformed) => {
      const flow = repo.create({ name: 'Draft', definition: DEF, nowMs: NOW });
      const saved = repo.saveDraft({
        id: flow.id,
        draft: OTHER_DEF,
        baseHash: flow.definitionHash,
        nowMs: NOW + 1,
      });
      expect(() =>
        repo.saveDraft({
          id: flow.id,
          draft: malformed as unknown as FlowDefinition,
          baseHash: flow.definitionHash,
          nowMs: NOW + 2,
        }),
      ).toThrow();
      expect(repo.getById(flow.id)).toEqual(saved);
    });

    it('discards only draft state and is idempotent', () => {
      const flow = repo.create({ name: 'Draft', definition: DEF, nowMs: NOW });
      repo.saveDraft({ id: flow.id, draft: OTHER_DEF, baseHash: flow.definitionHash, nowMs: NOW });
      repo.clearDraft(flow.id);
      repo.clearDraft(flow.id);
      expect(repo.getById(flow.id)).toEqual(flow);
      expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 }).total).toBe(
        1,
      );
    });

    it('refuses to save a draft for an unknown flow', () => {
      expect(() =>
        repo.saveDraft({ id: 'missing', draft: DEF, baseHash: 'hash', nowMs: NOW }),
      ).toThrow(/Unknown flow/);
    });

    it('rejects a stale publication without clearing the draft or appending history', () => {
      const flow = repo.create({ name: 'Draft', definition: DEF, nowMs: NOW });
      repo.update({ id: flow.id, definition: OTHER_DEF, nowMs: NOW + 1 });
      const saved = repo.saveDraft({
        id: flow.id,
        draft: DEF,
        baseHash: flow.definitionHash,
        nowMs: NOW + 2,
      });
      expect(() =>
        repo.update({
          id: flow.id,
          definition: DEF,
          baseHash: flow.definitionHash,
          nowMs: NOW + 3,
        }),
      ).toThrow(FlowChangedError);
      expect(repo.getById(flow.id)).toEqual(saved);
      expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 }).total).toBe(
        2,
      );
    });

    it('keeps the draft when publishing is invalid or the version append fails', () => {
      const flow = repo.create({ name: 'Draft', definition: DEF, nowMs: NOW });
      const saved = repo.saveDraft({
        id: flow.id,
        draft: OTHER_DEF,
        baseHash: flow.definitionHash,
        nowMs: NOW + 1,
      });
      expect(() => repo.update({ id: flow.id, definition: INVALID_DEF, nowMs: NOW + 2 })).toThrow();
      expect(repo.getById(flow.id)).toEqual(saved);

      db.exec(
        `CREATE TRIGGER boom BEFORE INSERT ON flow_version BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
      );
      expect(() => repo.update({ id: flow.id, definition: OTHER_DEF, nowMs: NOW + 2 })).toThrow(
        /boom/,
      );
      expect(repo.getById(flow.id)).toEqual(saved);
      expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 }).total).toBe(
        1,
      );
    });

    it.each([true, false])(
      'publishes and clears the draft with a base hash supplied: %s',
      (guard) => {
        const flow = repo.create({ name: 'Draft', definition: DEF, nowMs: NOW });
        repo.saveDraft({
          id: flow.id,
          draft: OTHER_DEF,
          baseHash: flow.definitionHash,
          nowMs: NOW,
        });
        const published = repo.update({
          id: flow.id,
          definition: OTHER_DEF,
          baseHash: guard ? flow.definitionHash : undefined,
          nowMs: NOW + 1,
        });
        expect(published).toMatchObject({
          definition: OTHER_DEF,
          draft: null,
          draftBaseHash: null,
          draftUpdatedAt: null,
        });
        expect(published.definitionHash).not.toBe(flow.definitionHash);
        expect(
          createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 }).total,
        ).toBe(2);
      },
    );
  });

  it('records a version on update, carrying the note', () => {
    const { db, repo } = seed();
    const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });
    repo.update({ id: flow.id, definition: OTHER_DEF, nowMs: 20, note: 'moved muxqueue' });

    const versions = createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 });
    expect(versions.total).toBe(2);
    expect(versions.items[0]!.note).toBe('moved muxqueue');
  });

  it('leaves the live definition and the newest version in agreement', () => {
    const { db, repo } = seed();
    const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });
    const updated = repo.update({ id: flow.id, definition: OTHER_DEF, nowMs: 20 });

    const newest = createFlowVersionRepo(db).list({ flowId: flow.id, limit: 1, offset: 0 })
      .items[0]!;
    expect(newest.definitionHash).toBe(updated.definitionHash);
  });

  it('writes NO version when the update is rejected as invalid', () => {
    const { db, repo } = seed();
    const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });

    expect(() => repo.update({ id: flow.id, definition: INVALID_DEF, nowMs: 20 })).toThrow();

    // still just the create's version
    expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 }).total).toBe(1);
  });

  it('appends a row for a re-publish that changes nothing', () => {
    const { db, repo } = seed();
    const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });
    const again = repo.update({ id: flow.id, definition: DEF, nowMs: 20 });

    expect(again.definitionHash).toBe(flow.definitionHash);
    expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 }).total).toBe(2);
  });

  it('rolls the definition write back when the version append fails', () => {
    // Forces a failure INSIDE the transaction, after the `flow` write has
    // already run but before it commits -- the one scenario the other
    // tests in this block cannot reach, because `assertFlowDefinitionValid`
    // always rejects before `updateTx` is ever called. If the
    // `db.transaction` wrapper around the UPDATE + append were removed, the
    // UPDATE below would already be committed by the time the INSERT
    // throws, and every assertion after it would fail.
    const { db, repo } = seed();
    const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });

    db.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON flow_version BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    try {
      expect(() => repo.update({ id: flow.id, definition: OTHER_DEF, nowMs: 20 })).toThrow(/boom/);
    } finally {
      db.exec(`DROP TRIGGER boom`);
    }

    const reread = repo.getById(flow.id)!;
    expect(reread.definitionHash).toBe(flow.definitionHash);
    expect(reread.updatedAt).toBe(flow.updatedAt);
    expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 }).total).toBe(1);
  });
});
