import { randomUUID } from 'node:crypto';
import {
  assertFlowDefinitionValid,
  flowDefinitionHash,
  FlowValidationError,
  validateFlowDefinition,
  type FlowDefinition,
  type FlowLayout,
  type FlowNodeCapabilityResolver,
} from '@trawlarr/core';
import { createNodeCapabilityResolver } from '../flow/node-capabilities.js';
import { parseFlowLayout } from '../flow/layout.js';
import { createPluginRegistry } from '../plugins/registry.js';
import type { Db } from './connection.js';
import { createFlowVersionRepo } from './flow-version-repo.js';

export interface FlowRecord {
  id: string;
  name: string;
  description: string;
  tags: string;
  definition: FlowDefinition;
  definitionHash: string;
  draft: FlowDefinition | null;
  draftBaseHash: string | null;
  draftUpdatedAt: number | null;
  layout: FlowLayout;
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
    note?: string;
  }): FlowRecord;
  update(input: {
    id: string;
    definition: FlowDefinition;
    nowMs: number;
    note?: string;
    baseHash?: string;
  }): FlowRecord;
  saveDraft(input: {
    id: string;
    draft: FlowDefinition;
    baseHash: string;
    nowMs: number;
  }): FlowRecord;
  clearDraft(id: string): void;
  saveLayout(id: string, layout: FlowLayout): FlowLayout;
  /**
   * Returns false when no such flow existed.
   *
   * `library.flow_id` is `ON DELETE SET NULL`, so a library pointed at a
   * deleted flow is DETACHED rather than left pointing at nothing — which is
   * exactly the state `checkLibraryHealth` pauses with a stated reason.
   * Callers that delete a flow are expected to re-check library health
   * immediately, so an operator learns their library stopped converging from
   * the library's own `pausedReason` rather than from a silent backlog.
   */
  remove(id: string): boolean;
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
  draft_json: string | null;
  draft_base_hash: string | null;
  draft_updated_at: number | null;
  layout_json: string;
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
  draft: row.draft_json === null ? null : (JSON.parse(row.draft_json) as FlowDefinition),
  draftBaseHash: row.draft_base_hash,
  draftUpdatedAt: row.draft_updated_at,
  layout: JSON.parse(row.layout_json) as FlowLayout,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class FlowChangedError extends Error {
  constructor() {
    super('The published flow changed since editing began. Reload it before publishing.');
    this.name = 'FlowChangedError';
  }
}

/**
 * Create and update are the only two doors a published definition enters
 * through, so they are where validation lives: the published definition is a
 * flow the executor has agreed to run. Drafts may be unfinished. Validation
 * REJECTS, never repairs — a repaired flow is a flow its author did not write,
 * running unattended over a library.
 *
 * Rows written before this check existed are deliberately left alone: nothing
 * revalidates on read, so a live database keeps working exactly as it did
 * (the executor is unchanged), and such a flow is rejected the next time
 * someone tries to store it. Repairing them on read is the one thing that
 * would be worse than leaving them: it would silently change the graph a
 * library is converging against, which is the flow's identity.
 *
 * Both methods also append a `flow_version` row IN THE SAME TRANSACTION as
 * the write to `flow`. That is not an optimization: a live definition whose
 * newest version disagreed with it would make the history lie about what
 * actually ran, which is worse than no history at all. Validation happens
 * before the transaction opens, so a rejected definition never appends a
 * version and never touches `flow` either.
 */
export const createFlowRepo = (
  db: Db,
  options?: { resolveNodeCapabilities?: FlowNodeCapabilityResolver },
): FlowRepo => {
  // Registry-aware by default: a flow naming an INSTALLED plugin must
  // validate against that plugin's real declaration, not be rejected because
  // the id is neither first-party nor a path. `createFlowRepo` already holds
  // `db`, so every existing caller gets this without changing.
  const resolveNodeCapabilities =
    options?.resolveNodeCapabilities ??
    createNodeCapabilityResolver({ registry: createPluginRegistry(db) });
  const selectById = db.prepare(`SELECT * FROM flow WHERE id = ?`);
  const selectByName = db.prepare(`SELECT * FROM flow WHERE name = ?`);
  const selectAll = db.prepare(`SELECT * FROM flow ORDER BY name`);
  const versionRepo = createFlowVersionRepo(db);

  const get = (id: string): FlowRecord | null => {
    const row = selectById.get(id) as FlowRow | undefined;
    return row === undefined ? null : toRecord(row);
  };

  const insertFlow = db.prepare(
    `INSERT INTO flow (id, name, description, tags, definition_json, definition_hash,
                       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateFlow = db.prepare(
    `UPDATE flow SET definition_json = ?, definition_hash = ?, updated_at = ?,
                     draft_json = NULL, draft_base_hash = NULL, draft_updated_at = NULL
     WHERE id = ?`,
  );

  // Both transactions are synchronous, as `db.transaction` requires: nothing
  // inside may `await`, and a thrown error rolls back everything, including
  // the version append.
  // The read-back happens INSIDE each transaction, not after it: reading
  // after commit would let the returned record and the version just
  // appended (both inside the transaction) disagree if anything else wrote
  // to this flow in between. There is a single writer, so that race is
  // theoretical today — but "theoretical" is not a reason to let the
  // returned value and the ledger drift, especially in the one place a
  // reviewer will check first when the two disagree.
  const createTx = db.transaction(
    (input: {
      id: string;
      name: string;
      description: string;
      tags: string;
      definition: FlowDefinition;
      definitionHash: string;
      nowMs: number;
      note: string;
    }): FlowRecord => {
      insertFlow.run(
        input.id,
        input.name,
        input.description,
        input.tags,
        JSON.stringify(input.definition),
        input.definitionHash,
        input.nowMs,
        input.nowMs,
      );
      versionRepo.append({
        flowId: input.id,
        definitionHash: input.definitionHash,
        definition: input.definition,
        note: input.note,
        nowMs: input.nowMs,
      });
      const created = get(input.id);
      if (created === null) throw new Error(`Flow ${input.id} vanished immediately after insert.`);
      return created;
    },
  );

  const updateTx = db.transaction(
    (input: {
      id: string;
      definition: FlowDefinition;
      definitionHash: string;
      nowMs: number;
      note: string;
      baseHash?: string;
    }): FlowRecord => {
      const current = get(input.id);
      if (current === null) throw new Error(`Unknown flow: ${input.id}`);
      if (input.baseHash !== undefined && input.baseHash !== current.definitionHash) {
        throw new FlowChangedError();
      }
      const result = updateFlow.run(
        JSON.stringify(input.definition),
        input.definitionHash,
        input.nowMs,
        input.id,
      );
      if (result.changes === 0) throw new Error(`Unknown flow: ${input.id}`);
      versionRepo.append({
        flowId: input.id,
        definitionHash: input.definitionHash,
        definition: input.definition,
        note: input.note,
        nowMs: input.nowMs,
      });
      const updated = get(input.id);
      if (updated === null) throw new Error(`Flow ${input.id} vanished immediately after update.`);
      return updated;
    },
  );

  const saveDraftTx = db.transaction(
    (input: { id: string; draft: FlowDefinition; baseHash: string; nowMs: number }): FlowRecord => {
      const result = db
        .prepare(
          `UPDATE flow SET draft_json = ?, draft_base_hash = ?, draft_updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify(input.draft), input.baseHash, input.nowMs, input.id);
      if (result.changes === 0) throw new Error(`Unknown flow: ${input.id}`);
      return get(input.id)!;
    },
  );

  return {
    create(input) {
      assertFlowDefinitionValid(input.definition, resolveNodeCapabilities);
      const id = randomUUID();
      return createTx({
        id,
        name: input.name,
        description: input.description ?? '',
        tags: input.tags ?? '',
        definition: input.definition,
        definitionHash: flowDefinitionHash(input.definition),
        nowMs: input.nowMs,
        note: input.note ?? '',
      });
    },

    update(input) {
      assertFlowDefinitionValid(input.definition, resolveNodeCapabilities);
      // The hash is recomputed here rather than read back, because it IS the
      // flow's version: every file whose ledger recorded the old hash becomes
      // stale the moment this returns.
      // Reserve the writer before comparing hashes, so another connection cannot
      // publish between the optimistic-concurrency check and the definition write.
      return updateTx.immediate({
        id: input.id,
        definition: input.definition,
        definitionHash: flowDefinitionHash(input.definition),
        nowMs: input.nowMs,
        note: input.note ?? '',
        baseHash: input.baseHash,
      });
    },

    saveDraft(input) {
      // Only shape blocks persistence; duplicate nodes, dangling edges and an
      // empty graph are all legitimate intermediate editing states.
      const malformed = validateFlowDefinition(input.draft).filter(
        (problem) => problem.code === 'malformed',
      );
      if (malformed.length > 0) throw new FlowValidationError(malformed);
      if (input.draft.nodes.some((node) => Array.isArray(node.inputs))) {
        throw new FlowValidationError([
          { code: 'malformed', message: 'Node inputs must be an object, not an array.' },
        ]);
      }
      return saveDraftTx(input);
    },

    clearDraft(id) {
      db.prepare(
        `UPDATE flow SET draft_json = NULL, draft_base_hash = NULL, draft_updated_at = NULL
         WHERE id = ?`,
      ).run(id);
    },

    saveLayout(id, layout) {
      const parsed = parseFlowLayout(layout);
      // Layout writes never touch definition/hash, draft timestamps, or history.
      const result = db
        .prepare('UPDATE flow SET layout_json = ? WHERE id = ?')
        .run(JSON.stringify(parsed), id);
      if (result.changes === 0) throw new Error(`Unknown flow: ${id}`);
      return parsed;
    },

    remove(id) {
      return db.prepare(`DELETE FROM flow WHERE id = ?`).run(id).changes > 0;
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
