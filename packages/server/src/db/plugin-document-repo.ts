import type { Db } from './connection.js';

export type PluginDocument = Record<string, unknown>;

export interface PluginDocumentRepo {
  get(collection: string, docId: string): PluginDocument | undefined;
  insert(collection: string, docId: string, data: PluginDocument, nowMs: number): void;
  update(collection: string, docId: string, patch: PluginDocument, nowMs: number): void;
  removeOne(collection: string, docId: string): void;
}

/**
 * Generic document storage backing deps.crudTransDBN. Plugins invent their
 * own collection names (F2FOutputJSONDB is one such), so this must accept
 * anything rather than validating against a known set.
 */
export const createPluginDocumentRepo = (db: Db): PluginDocumentRepo => {
  const selectOne = db.prepare(
    `SELECT data_json FROM plugin_document WHERE collection = ? AND doc_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO plugin_document (collection, doc_id, data_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(collection, doc_id)
       DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
  );
  const deleteOne = db.prepare(`DELETE FROM plugin_document WHERE collection = ? AND doc_id = ?`);

  const read = (collection: string, docId: string): PluginDocument | undefined => {
    const row = selectOne.get(collection, docId) as { data_json: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.data_json) as PluginDocument);
  };

  return {
    get: read,

    insert(collection, docId, data, nowMs) {
      upsert.run(collection, docId, JSON.stringify(data), nowMs);
    },

    update(collection, docId, patch, nowMs) {
      const merged = { ...(read(collection, docId) ?? {}), ...patch };
      upsert.run(collection, docId, JSON.stringify(merged), nowMs);
    },

    removeOne(collection, docId) {
      deleteOne.run(collection, docId);
    },
  };
};
