import { randomUUID } from 'node:crypto';
import type { FlowDefinition } from '@trawlarr/core';
import type { Db } from './connection.js';

export interface FlowVersionRecord {
  id: string;
  flowId: string;
  definitionHash: string;
  definition: FlowDefinition;
  note: string;
  createdAt: number;
}

/**
 * Same as `FlowVersionRecord` but without the definition. A flow that has
 * been published hundreds of times still has a history worth listing — dates,
 * notes, hashes — and a caller rendering that list has no use for the
 * definitions behind each entry. Carrying them along anyway would turn a
 * page of dates into a response of hundreds of kilobytes for no reader.
 */
export interface FlowVersionSummary {
  id: string;
  flowId: string;
  definitionHash: string;
  note: string;
  createdAt: number;
}

export interface FlowVersionRepo {
  append(input: {
    flowId: string;
    definitionHash: string;
    definition: FlowDefinition;
    note: string;
    nowMs: number;
  }): FlowVersionRecord;
  list(input: { flowId: string; limit: number; offset: number }): {
    total: number;
    items: FlowVersionSummary[];
  };
  get(id: string): FlowVersionRecord | null;
  /**
   * Resolves a hash to the newest version carrying it — `definition_hash` is
   * deliberately not unique, so publishing A, then B, then A again leaves two
   * rows sharing a hash, and only the newest one reflects what "this hash"
   * currently means to the flow's history.
   *
   * `flowId` scopes the search, and a caller that knows it must pass it. A
   * hash is a pure function of the definition, so two flows with the same
   * graph — duplicating a flow for Movies and Shows is the obvious way to get
   * there — share every hash they publish. Unscoped, a job on the Movies flow
   * resolves to a Shows version, and the restore button on that page then
   * republishes and re-queues the wrong library.
   */
  byHash(input: { hash: string; flowId?: string }): FlowVersionRecord | null;
}

interface FlowVersionRow {
  id: string;
  flow_id: string;
  definition_hash: string;
  definition_json: string;
  note: string;
  created_at: number;
}

interface FlowVersionSummaryRow {
  id: string;
  flow_id: string;
  definition_hash: string;
  note: string;
  created_at: number;
}

const toRecord = (row: FlowVersionRow): FlowVersionRecord => ({
  id: row.id,
  flowId: row.flow_id,
  definitionHash: row.definition_hash,
  definition: JSON.parse(row.definition_json) as FlowDefinition,
  note: row.note,
  createdAt: row.created_at,
});

const toSummary = (row: FlowVersionSummaryRow): FlowVersionSummary => ({
  id: row.id,
  flowId: row.flow_id,
  definitionHash: row.definition_hash,
  note: row.note,
  createdAt: row.created_at,
});

/**
 * `flow_version` is the append-only ledger behind a flow's history: one row
 * per publish, never updated, never deleted except by the flow's own
 * cascade. This repo therefore has no `update` or `remove` — only `append`
 * and read paths, because rewriting history is exactly what the table
 * exists to prevent.
 */
export const createFlowVersionRepo = (db: Db): FlowVersionRepo => {
  const selectById = db.prepare(`SELECT * FROM flow_version WHERE id = ?`);
  // `created_at` alone is not a total order: two rows can legitimately share
  // a millisecond (a create immediately followed by an update through the
  // API, both stamped with the same `nowMs`), and without a tiebreak SQLite
  // is free to return them in either order. `rowid` breaks the tie
  // deterministically and keeps the newer row first: this table has no
  // `WITHOUT ROWID` clause and its primary key is TEXT rather than
  // `INTEGER PRIMARY KEY`, so SQLite still assigns a hidden rowid that
  // increases with each insert — exactly the append order this ledger cares
  // about.
  const selectByFlow = db.prepare(
    `SELECT id, flow_id, definition_hash, note, created_at
     FROM flow_version WHERE flow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
  );
  const countByFlow = db.prepare(`SELECT COUNT(*) AS n FROM flow_version WHERE flow_id = ?`);
  // Newest match first, so LIMIT 1 answers "the newest version carrying this
  // hash" without scanning every row that ever shared it. Same `rowid`
  // tiebreak as `selectByFlow` above, and for the same reason: a hash can
  // repeat within the millisecond a create and an update through the API
  // share, and `created_at` alone cannot order those two rows.
  const selectByHash = db.prepare(
    `SELECT * FROM flow_version WHERE definition_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  const selectByHashInFlow = db.prepare(
    `SELECT * FROM flow_version WHERE definition_hash = ? AND flow_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );

  const get = (id: string): FlowVersionRecord | null => {
    const row = selectById.get(id) as FlowVersionRow | undefined;
    return row === undefined ? null : toRecord(row);
  };

  return {
    append(input) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO flow_version (id, flow_id, definition_hash, definition_json, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.flowId,
        input.definitionHash,
        JSON.stringify(input.definition),
        input.note,
        input.nowMs,
      );
      const created = get(id);
      if (created === null)
        throw new Error(`Flow version ${id} vanished immediately after insert.`);
      return created;
    },

    list(input) {
      const total = (countByFlow.get(input.flowId) as { n: number }).n;
      const items = (
        selectByFlow.all(input.flowId, input.limit, input.offset) as FlowVersionSummaryRow[]
      ).map(toSummary);
      return { total, items };
    },

    get,

    byHash(input) {
      const row = (
        input.flowId === undefined
          ? selectByHash.get(input.hash)
          : selectByHashInFlow.get(input.hash, input.flowId)
      ) as FlowVersionRow | undefined;
      return row === undefined ? null : toRecord(row);
    },
  };
};
