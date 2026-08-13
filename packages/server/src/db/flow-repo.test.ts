import { beforeEach, describe, expect, it } from 'vitest';
import { flowDefinitionHash, type FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createFlowRepo, type FlowRepo } from './flow-repo.js';

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

let db: Db;
let repo: FlowRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createFlowRepo(db);
});

describe('createFlowRepo', () => {
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
