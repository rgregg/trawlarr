import { randomUUID } from 'node:crypto';
import {
  assertFlowDefinitionValid,
  flowDefinitionHash,
  type FlowDefinition,
  type FlowNodeCapabilityResolver,
} from '@trawlarr/core';
import { createNodeCapabilityResolver } from '../flow/node-capabilities.js';
import type { Db } from './connection.js';

export interface FlowRecord {
  id: string;
  name: string;
  description: string;
  tags: string;
  definition: FlowDefinition;
  definitionHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface FlowRepo {
  create(input: {
    name: string;
    description?: string;
    tags?: string;
    definition: FlowDefinition;
    nowMs: number;
  }): FlowRecord;
  update(input: { id: string; definition: FlowDefinition; nowMs: number }): FlowRecord;
  getById(id: string): FlowRecord | null;
  getByName(name: string): FlowRecord | null;
  list(): FlowRecord[];
}

interface FlowRow {
  id: string;
  name: string;
  description: string;
  tags: string;
  definition_json: string;
  definition_hash: string;
  created_at: number;
  updated_at: number;
}

const toRecord = (row: FlowRow): FlowRecord => ({
  id: row.id,
  name: row.name,
  description: row.description,
  tags: row.tags,
  definition: JSON.parse(row.definition_json) as FlowDefinition,
  definitionHash: row.definition_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Create and update are the only two doors a definition enters through, so
 * they are where validation lives: anything in the `flow` table is a flow the
 * executor has agreed to run. Validation REJECTS, never repairs — a repaired
 * flow is a flow its author did not write, running unattended over a library.
 *
 * Rows written before this check existed are deliberately left alone: nothing
 * revalidates on read, so a live database keeps working exactly as it did
 * (the executor is unchanged), and such a flow is rejected the next time
 * someone tries to store it. Repairing them on read is the one thing that
 * would be worse than leaving them: it would silently change the graph a
 * library is converging against, which is the flow's identity.
 */
export const createFlowRepo = (
  db: Db,
  options?: { resolveNodeCapabilities?: FlowNodeCapabilityResolver },
): FlowRepo => {
  const resolveNodeCapabilities =
    options?.resolveNodeCapabilities ?? createNodeCapabilityResolver();
  const selectById = db.prepare(`SELECT * FROM flow WHERE id = ?`);
  const selectByName = db.prepare(`SELECT * FROM flow WHERE name = ?`);
  const selectAll = db.prepare(`SELECT * FROM flow ORDER BY name`);

  const get = (id: string): FlowRecord | null => {
    const row = selectById.get(id) as FlowRow | undefined;
    return row === undefined ? null : toRecord(row);
  };

  return {
    create(input) {
      assertFlowDefinitionValid(input.definition, resolveNodeCapabilities);
      const id = randomUUID();
      db.prepare(
        `INSERT INTO flow (id, name, description, tags, definition_json, definition_hash,
                           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        input.description ?? '',
        input.tags ?? '',
        JSON.stringify(input.definition),
        flowDefinitionHash(input.definition),
        input.nowMs,
        input.nowMs,
      );
      const created = get(id);
      if (created === null) throw new Error(`Flow ${id} vanished immediately after insert.`);
      return created;
    },

    update(input) {
      assertFlowDefinitionValid(input.definition, resolveNodeCapabilities);
      // The hash is recomputed here rather than read back, because it IS the
      // flow's version: every file whose ledger recorded the old hash becomes
      // stale the moment this returns.
      const result = db
        .prepare(
          `UPDATE flow SET definition_json = ?, definition_hash = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(input.definition),
          flowDefinitionHash(input.definition),
          input.nowMs,
          input.id,
        );
      if (result.changes === 0) throw new Error(`Unknown flow: ${input.id}`);
      const updated = get(input.id);
      if (updated === null) throw new Error(`Flow ${input.id} vanished immediately after update.`);
      return updated;
    },

    getById: get,

    getByName(name) {
      const row = selectByName.get(name) as FlowRow | undefined;
      return row === undefined ? null : toRecord(row);
    },

    list() {
      return (selectAll.all() as FlowRow[]).map(toRecord);
    },
  };
};
