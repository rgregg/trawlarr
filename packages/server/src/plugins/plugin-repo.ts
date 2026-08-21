import type { PluginDetails } from '@trawlarr/plugin-api';
import type { Db } from '../db/connection.js';
import { assertValidSourceSlug, formatPluginId, parsePluginId } from './plugin-id.js';

export type PluginSourceKind = 'tarball' | 'local';

const SOURCE_KINDS: readonly PluginSourceKind[] = ['tarball', 'local'];

export interface PluginSourceRow {
  id: string;
  url: string;
  kind: PluginSourceKind;
  enabled: boolean;
  lastSyncedAtMs: number | null;
}

export interface DiscoveredPlugin {
  pluginName: string;
  relPath: string;
  absPath: string;
  version: string;
  details: PluginDetails;
}

export interface InstalledPluginRow {
  id: string;
  sourceId: string | null;
  relPath: string;
  absPath: string;
  version: string;
  details: PluginDetails;
  enabled: boolean;
}

export interface PluginRepo {
  listSources(): PluginSourceRow[];
  getSource(id: string): PluginSourceRow | null;
  addSource(input: { id: string; url: string; kind: PluginSourceKind }): PluginSourceRow;
  setSourceEnabled(id: string, enabled: boolean): void;
  removeSource(id: string): void;
  markSynced(id: string, atMs: number): void;
  listPlugins(sourceId?: string): InstalledPluginRow[];
  getPlugin(id: string): InstalledPluginRow | null;
  /**
   * Make this source's installed set EXACTLY these plugins, in one
   * transaction. Not an upsert: a plugin upstream deleted must disappear,
   * or a flow keeps naming a path that is no longer there and fails on the
   * first file with an error that names a file rather than a plugin.
   */
  replaceSourcePlugins(sourceId: string, plugins: DiscoveredPlugin[]): void;
  /** Only ids this host actually has. Unknown ids are absent, never guessed. */
  resolveAbsPaths(ids: readonly string[]): Record<string, string>;
}

export class PluginRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRepoError';
  }
}

interface PluginSourceDbRow {
  id: string;
  url: string;
  kind: string;
  enabled: number;
  last_synced_at: number | null;
}

interface PluginDbRow {
  id: string;
  source_id: string | null;
  rel_path: string;
  abs_path: string;
  version: string;
  details_json: string;
  enabled: number;
}

/**
 * `kind` is validated on READ as well as on write, the way `SettingsRepo`
 * validates settings: it is a text column in a file an operator can open with
 * the sqlite CLI, and a value nothing understands should surface here rather
 * than as an unexplained "nothing synced" three layers away.
 */
const toSourceRow = (row: PluginSourceDbRow): PluginSourceRow => {
  if (!SOURCE_KINDS.includes(row.kind as PluginSourceKind)) {
    throw new PluginRepoError(
      `Plugin source "${row.id}" has kind "${row.kind}", which is not one of ` +
        `${SOURCE_KINDS.join(', ')}.`,
    );
  }
  return {
    id: row.id,
    url: row.url,
    kind: row.kind as PluginSourceKind,
    enabled: row.enabled !== 0,
    lastSyncedAtMs: row.last_synced_at,
  };
};

const toPluginRow = (row: PluginDbRow): InstalledPluginRow => ({
  id: row.id,
  sourceId: row.source_id,
  relPath: row.rel_path,
  absPath: row.abs_path,
  version: row.version,
  details: JSON.parse(row.details_json) as PluginDetails,
  enabled: row.enabled !== 0,
});

export const createPluginRepo = (db: Db): PluginRepo => {
  const selectSource = db.prepare(`SELECT * FROM plugin_source WHERE id = ?`);
  const selectSources = db.prepare(`SELECT * FROM plugin_source ORDER BY id`);
  const selectSourceByUrl = db.prepare(`SELECT * FROM plugin_source WHERE url = ?`);
  const selectPlugin = db.prepare(`SELECT * FROM plugin WHERE id = ?`);
  const selectPlugins = db.prepare(`SELECT * FROM plugin ORDER BY id`);
  const selectPluginsBySource = db.prepare(`SELECT * FROM plugin WHERE source_id = ? ORDER BY id`);
  const deletePluginsOfSource = db.prepare(`DELETE FROM plugin WHERE source_id = ?`);
  const insertPlugin = db.prepare(
    `INSERT INTO plugin (id, source_id, rel_path, abs_path, version, details_json, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  );

  const getSource = (id: string): PluginSourceRow | null => {
    const row = selectSource.get(id) as PluginSourceDbRow | undefined;
    return row === undefined ? null : toSourceRow(row);
  };

  const requireSource = (id: string): PluginSourceRow => {
    const source = getSource(id);
    if (source === null) throw new PluginRepoError(`Unknown plugin source: "${id}".`);
    return source;
  };

  /**
   * Written as one transaction so a sync that dies half way leaves the
   * previous set intact rather than an arbitrary prefix of the new one.
   */
  const replaceSourcePlugins = db.transaction((sourceId: string, plugins: DiscoveredPlugin[]) => {
    requireSource(sourceId);
    deletePluginsOfSource.run(sourceId);
    for (const plugin of plugins) {
      const id = formatPluginId({ sourceSlug: sourceId, pluginName: plugin.pluginName });
      // Round-trip through the parser, so nothing can be stored under an id
      // that the daemon and the worker would later read back differently.
      if (parsePluginId(id) === null) {
        throw new PluginRepoError(
          `Plugin name "${plugin.pluginName}" in source "${sourceId}" cannot form a plugin id. ` +
            `Names may use letters, digits, dots, hyphens and underscores.`,
        );
      }
      insertPlugin.run(
        id,
        sourceId,
        plugin.relPath,
        plugin.absPath,
        plugin.version,
        JSON.stringify(plugin.details),
      );
    }
  });

  return {
    listSources() {
      return (selectSources.all() as PluginSourceDbRow[]).map(toSourceRow);
    },

    getSource,

    addSource(input) {
      assertValidSourceSlug(input.id);
      if (!SOURCE_KINDS.includes(input.kind)) {
        throw new PluginRepoError(
          `Plugin source kind "${input.kind}" is not one of ${SOURCE_KINDS.join(', ')}.`,
        );
      }
      const clash = selectSourceByUrl.get(input.url) as PluginSourceDbRow | undefined;
      if (clash !== undefined) {
        throw new PluginRepoError(
          `A plugin source with url "${input.url}" already exists (named "${clash.id}"). ` +
            `Remove it first, or sync it instead of adding it again.`,
        );
      }
      db.prepare(
        `INSERT INTO plugin_source (id, url, kind, enabled, last_synced_at)
         VALUES (?, ?, ?, 1, NULL)`,
      ).run(input.id, input.url, input.kind);
      const created = getSource(input.id);
      if (created === null) {
        throw new PluginRepoError(`Plugin source ${input.id} vanished immediately after insert.`);
      }
      return created;
    },

    setSourceEnabled(id, enabled) {
      const result = db
        .prepare(`UPDATE plugin_source SET enabled = ? WHERE id = ?`)
        .run(enabled ? 1 : 0, id);
      if (result.changes === 0) throw new PluginRepoError(`Unknown plugin source: "${id}".`);
    },

    removeSource(id) {
      // `plugin.source_id` is ON DELETE CASCADE, so the installed set goes
      // with it: leaving rows behind would let a flow validate against a
      // plugin whose files this host no longer has.
      db.prepare(`DELETE FROM plugin_source WHERE id = ?`).run(id);
    },

    markSynced(id, atMs) {
      const result = db
        .prepare(`UPDATE plugin_source SET last_synced_at = ? WHERE id = ?`)
        .run(atMs, id);
      if (result.changes === 0) throw new PluginRepoError(`Unknown plugin source: "${id}".`);
    },

    listPlugins(sourceId) {
      const rows = (
        sourceId === undefined ? selectPlugins.all() : selectPluginsBySource.all(sourceId)
      ) as PluginDbRow[];
      return rows.map(toPluginRow);
    },

    getPlugin(id) {
      const row = selectPlugin.get(id) as PluginDbRow | undefined;
      return row === undefined ? null : toPluginRow(row);
    },

    replaceSourcePlugins(sourceId, plugins) {
      replaceSourcePlugins(sourceId, plugins);
    },

    resolveAbsPaths(ids) {
      // Filtered before any query: a first-party id or an absolute path must
      // never reach the database as a lookup key.
      const wanted = [...new Set(ids.filter((id) => parsePluginId(id) !== null))];
      const resolved: Record<string, string> = {};
      for (const id of wanted) {
        const row = selectPlugin.get(id) as PluginDbRow | undefined;
        if (row !== undefined) resolved[row.id] = row.abs_path;
      }
      return resolved;
    },
  };
};
