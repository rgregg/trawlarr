import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { Db } from './connection.js';
import { pathContains } from '../fs/path-contains.js';

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

const overlaps = (a: string, b: string): boolean => pathContains(a, b) || pathContains(b, a);

/**
 * Thrown when a configured `stagingDir`/`trashDir` is not an absolute path.
 *
 * `resolve()`ing a relative path is defined against `process.cwd()` — but a
 * library has multiple roots, and the server process's working directory
 * has no relationship to any of them, so there is no defensible base to
 * resolve against. Silently picking one (the cwd at the moment `create()`
 * happens to run) is exactly how this became a bug: a relative `stagingDir`
 * stored that way stages multi-gigabyte transcodes into wherever the
 * service happened to be started from, on whatever device that happens to
 * be — the very thing `CrossDeviceStagingError` exists to prevent. Failing
 * loudly here is trivially actionable: the caller supplies an absolute path.
 */
export class RelativeReservedDirectoryError extends Error {
  constructor(input: { kind: 'stagingDir' | 'trashDir'; value: string }) {
    super(
      `${input.kind} "${input.value}" is not an absolute path. A library can have multiple ` +
        `roots, and the server process's working directory has no relationship to any of them, ` +
        `so there is no correct base to resolve a relative ${input.kind} against — that ambiguity ` +
        `is exactly how a relative ${input.kind} ends up staging transcodes into wherever the ` +
        `service happened to be started from. Supply an absolute path, or unset ${input.kind} to ` +
        `use the per-root default.`,
    );
    this.name = 'RelativeReservedDirectoryError';
  }
}

/**
 * Rejects a relative `stagingDir`/`trashDir` outright (see
 * {@link RelativeReservedDirectoryError}) rather than resolving it against
 * a cwd nobody chose. For an already-absolute path, `resolve()` only
 * normalises redundant separators and `.`/`..` segments — it does not
 * consult `process.cwd()` when the input is already absolute — so this
 * still returns a clean, comparable value without reintroducing the cwd
 * dependency.
 */
const requireAbsolute = (kind: 'stagingDir' | 'trashDir', value: string): string => {
  if (!isAbsolute(value)) throw new RelativeReservedDirectoryError({ kind, value });
  return resolve(value);
};

/**
 * Thrown when a configured `stagingDir`/`trashDir` equals or contains a
 * library root. Staging *inside* a root (the default shape) is fine and
 * deliberately not rejected here — it's the reverse, a reserved directory
 * that a root sits under, that silently prunes the whole root from every
 * scan (`pathContains(root, root)` is true, so the root itself is the
 * first thing excluded) and leaves the library looking permanently empty
 * with no error.
 */
export class ReservedDirectoryOverlapsRootError extends Error {
  constructor(input: { kind: 'stagingDir' | 'trashDir'; dir: string; root: string }) {
    super(
      `Configured ${input.kind} "${input.dir}" contains or equals library root "${input.root}". ` +
        `A staging/trash directory must not contain a root it is meant to serve — that would ` +
        `prune the root itself out of every scan, leaving the library silently empty. Point ` +
        `${input.kind} somewhere that doesn't contain a root (inside a root is fine, and is the ` +
        `default), or unset it.`,
    );
    this.name = 'ReservedDirectoryOverlapsRootError';
  }
}

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

      // Validated (and normalised) before the overlap check below, so a
      // relative path reports "must be absolute" rather than a confusing
      // containment result derived from a cwd the user never chose.
      const stagingDir =
        input.stagingDir != null ? requireAbsolute('stagingDir', input.stagingDir) : null;
      const trashDir = input.trashDir != null ? requireAbsolute('trashDir', input.trashDir) : null;

      // Staging/trash *inside* a root is the default shape and must stay
      // allowed; it's a staging/trash dir that equals or CONTAINS a root
      // that silently prunes the root itself out of every scan.
      for (const [kind, dir] of [
        ['stagingDir', stagingDir],
        ['trashDir', trashDir],
      ] as const) {
        if (dir === null) continue;
        for (const root of roots) {
          if (pathContains(dir, root)) {
            throw new ReservedDirectoryOverlapsRootError({ kind, dir, root });
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
        stagingDir,
        trashDir,
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
