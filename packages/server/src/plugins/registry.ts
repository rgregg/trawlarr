import type { Db } from '../db/connection.js';
import { createPluginRepo } from './plugin-repo.js';
import { parsePluginId } from './plugin-id.js';

/**
 * The single answer to "what file is this plugin id?".
 *
 * Deliberately uncached and deliberately tiny. Uncached because a sync must
 * take effect on the next validation — a cache here means "I just installed
 * it and trawlarr says it does not exist". Tiny because it is the seam handed
 * to the flow validator, library health and the payload builder, none of
 * which should need a database handle to be tested.
 *
 * `null` is the only answer for anything that is NOT an installed id — a
 * first-party `trawlarr:*` id, an absolute path, a malformed id — so every
 * caller can ask this first and fall through to whatever it did before.
 */
export interface PluginRegistry {
  resolveAbsPath(pluginId: string): string | null;
  resolveMany(ids: readonly string[]): Record<string, string>;
}

export const createPluginRegistry = (db: Db): PluginRegistry => {
  const repo = createPluginRepo(db);
  return {
    resolveAbsPath: (pluginId) => {
      // `parsePluginId` rejects first-party ids and absolute paths, so those
      // never reach the database and keep their existing resolution.
      if (parsePluginId(pluginId) === null) return null;
      return repo.resolveAbsPaths([pluginId])[pluginId] ?? null;
    },
    resolveMany: (ids) => repo.resolveAbsPaths(ids),
  };
};
