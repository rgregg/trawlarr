import { describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';
import { createFlowVersionRepo } from './flow-version-repo.js';

const NOW = 1_700_000_000_000;

const DEF: FlowDefinition = { nodes: [], edges: [] };

const seed = () => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  const flowId = 'flow-1';
  db.prepare(
    `INSERT INTO flow (id, name, description, tags, definition_json, definition_hash,
                       created_at, updated_at)
     VALUES (?, ?, '', '', ?, 'seed-hash', ?, ?)`,
  ).run(flowId, 'Seed flow', JSON.stringify(DEF), NOW, NOW);
  return { db, flowId };
};

describe('flow version repo', () => {
  it('lists newest first without carrying definitions', () => {
    const { db, flowId } = seed();
    const repo = createFlowVersionRepo(db);
    repo.append({ flowId, definitionHash: 'h1', definition: DEF, note: 'first', nowMs: 10 });
    repo.append({ flowId, definitionHash: 'h2', definition: DEF, note: 'second', nowMs: 20 });

    const page = repo.list({ flowId, limit: 10, offset: 0 });

    expect(page.total).toBe(2);
    expect(page.items.map((v) => v.note)).toEqual(['second', 'first']);
    expect(page.items[0]).not.toHaveProperty('definition');
  });

  it('keeps both rows when a definition is published, reverted, and published again', () => {
    const { db, flowId } = seed();
    const repo = createFlowVersionRepo(db);
    repo.append({ flowId, definitionHash: 'a', definition: DEF, note: '', nowMs: 10 });
    repo.append({ flowId, definitionHash: 'b', definition: DEF, note: '', nowMs: 20 });
    repo.append({ flowId, definitionHash: 'a', definition: DEF, note: '', nowMs: 30 });

    expect(repo.list({ flowId, limit: 10, offset: 0 }).total).toBe(3);
  });

  it('resolves a hash to the newest version carrying it', () => {
    const { db, flowId } = seed();
    const repo = createFlowVersionRepo(db);
    repo.append({ flowId, definitionHash: 'a', definition: DEF, note: 'old', nowMs: 10 });
    repo.append({ flowId, definitionHash: 'a', definition: DEF, note: 'new', nowMs: 30 });

    expect(repo.byHash('a')?.note).toBe('new');
  });

  it('answers null for a hash that was never recorded', () => {
    const { db } = seed();
    expect(createFlowVersionRepo(db).byHash('never')).toBeNull();
  });

  it('breaks a created_at tie deterministically, newer row first', () => {
    // Two rows can legitimately share a millisecond -- a create immediately
    // followed by an update through the API, both stamped with the same
    // `nowMs`. Without a tiebreak in `ORDER BY`, SQLite is free to return
    // them in either order.
    const { db, flowId } = seed();
    const repo = createFlowVersionRepo(db);
    const first = repo.append({
      flowId,
      definitionHash: 'a',
      definition: DEF,
      note: 'first',
      nowMs: 10,
    });
    const second = repo.append({
      flowId,
      definitionHash: 'b',
      definition: DEF,
      note: 'second',
      nowMs: 10,
    });

    const page = repo.list({ flowId, limit: 10, offset: 0 });

    expect(page.items.map((v) => v.id)).toEqual([second.id, first.id]);
  });

  it('round-trips the definition through JSON', () => {
    const { db, flowId } = seed();
    const repo = createFlowVersionRepo(db);
    const def: FlowDefinition = {
      nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
      edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'end' }],
    };
    const appended = repo.append({
      flowId,
      definitionHash: 'h',
      definition: def,
      note: '',
      nowMs: 10,
    });

    expect(repo.get(appended.id)?.definition).toEqual(def);
  });
});
