import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { Db } from './connection.js';

export interface LibraryRecord {
  id: string;
  name: string;
  roots: string[];
  extensions: string[];
  companionExtensions: string[];
  stagingDir: string | null;
  trashDir: string | null;
  flowId: string | null;
  allowHardlinked: boolean;
  enabled: boolean;
  pausedReason: string | null;
  userVariables: Record<string, string>;
  createdAt: number;
}

export interface CreateLibraryInput {
  name: string;
  roots: string[];
  extensions?: string[];
  companionExtensions?: string[];
  stagingDir?: string | null;
  trashDir?: string | null;
  flowId?: string | null;
  allowHardlinked?: boolean;
  nowMs: number;
}

export interface LibraryRepo {
  create(input: CreateLibraryInput): LibraryRecord;
  getById(id: string): LibraryRecord | null;
  getByName(name: string): LibraryRecord | null;
  list(): LibraryRecord[];
  setFlow(id: string, flowId: string | null): void;
  pause(id: string, reason: string): void;
  resume(id: string): void;
}

export const DEFAULT_EXTENSIONS = ['mkv', 'mp4', 'avi', 'mov', 'm4v', 'ts', 'wmv', 'webm'] as const;

/**
 * Sidecars that belong to a media file and must follow it when a flow changes
 * the container, or a media server loses their association.
 */
export const DEFAULT_COMPANION_EXTENSIONS = ['srt', 'ass', 'sub', 'idx', 'nfo', 'vtt'] as const;

export class OverlappingRootsError extends Error {
  constructor(a: string, b: string) {
    super(
      `Library roots overlap: "${a}" contains or equals "${b}". A file under two roots would be ` +
        `scanned twice, and a file in two libraries would be driven toward two different states ` +
        `by two flows.`,
    );
    this.name = 'OverlappingRootsError';
  }
}

/** Compare as path segments so '/media/movies-4k' is not "inside" '/media/movies'. */
const contains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

const overlaps = (a: string, b: string): boolean => contains(a, b) || contains(b, a);

interface LibraryRow {
  id: string;
  name: string;
  roots_json: string;
  extensions_json: string;
  companion_extensions_json: string;
  staging_dir: string | null;
  trash_dir: string | null;
  flow_id: string | null;
  allow_hardlinked: number;
  enabled: number;
  paused_reason: string | null;
  user_variables_json: string;
  created_at: number;
}

const toRecord = (row: LibraryRow): LibraryRecord => ({
  id: row.id,
  name: row.name,
  roots: JSON.parse(row.roots_json) as string[],
  extensions: JSON.parse(row.extensions_json) as string[],
  companionExtensions: JSON.parse(row.companion_extensions_json) as string[],
  stagingDir: row.staging_dir,
  trashDir: row.trash_dir,
  flowId: row.flow_id,
  allowHardlinked: row.allow_hardlinked === 1,
  enabled: row.enabled === 1,
  pausedReason: row.paused_reason,
  userVariables: JSON.parse(row.user_variables_json) as Record<string, string>,
  createdAt: row.created_at,
});

export const createLibraryRepo = (db: Db): LibraryRepo => {
  const selectById = db.prepare(`SELECT * FROM library WHERE id = ?`);
  const selectByName = db.prepare(`SELECT * FROM library WHERE name = ?`);
  const selectAll = db.prepare(`SELECT * FROM library ORDER BY name`);

  const get = (id: string): LibraryRecord | null => {
    const row = selectById.get(id) as LibraryRow | undefined;
    return row === undefined ? null : toRecord(row);
  };

  const list = (): LibraryRecord[] => (selectAll.all() as LibraryRow[]).map(toRecord);

  return {
    create(input) {
      if (input.roots.length === 0) {
        throw new Error(`Library "${input.name}" needs at least one root directory.`);
      }
      const roots = input.roots.map((root) => resolve(root));

      for (let i = 0; i < roots.length; i += 1) {
        for (let j = i + 1; j < roots.length; j += 1) {
          if (overlaps(roots[i]!, roots[j]!)) throw new OverlappingRootsError(roots[i]!, roots[j]!);
        }
      }
      for (const existing of list()) {
        for (const existingRoot of existing.roots) {
          for (const root of roots) {
            if (overlaps(existingRoot, root)) throw new OverlappingRootsError(existingRoot, root);
          }
        }
      }

      const id = randomUUID();
      db.prepare(
        `INSERT INTO library (
           id, name, roots_json, extensions_json, companion_extensions_json,
           staging_dir, trash_dir, flow_id, allow_hardlinked, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        JSON.stringify(roots),
        JSON.stringify(input.extensions ?? [...DEFAULT_EXTENSIONS]),
        JSON.stringify(input.companionExtensions ?? [...DEFAULT_COMPANION_EXTENSIONS]),
        input.stagingDir ?? null,
        input.trashDir ?? null,
        input.flowId ?? null,
        input.allowHardlinked === true ? 1 : 0,
        input.nowMs,
      );
      const created = get(id);
      if (created === null) throw new Error(`Library ${id} vanished immediately after insert.`);
      return created;
    },

    getById: get,

    getByName(name) {
      const row = selectByName.get(name) as LibraryRow | undefined;
      return row === undefined ? null : toRecord(row);
    },

    list,

    setFlow(id, flowId) {
      db.prepare(`UPDATE library SET flow_id = ? WHERE id = ?`).run(flowId, id);
    },

    pause(id, reason) {
      db.prepare(`UPDATE library SET enabled = 0, paused_reason = ? WHERE id = ?`).run(reason, id);
    },

    resume(id) {
      db.prepare(`UPDATE library SET enabled = 1, paused_reason = NULL WHERE id = ?`).run(id);
    },
  };
};
