import { classifySideEffects, createPluginLoader } from '@trawlarr/engine';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import type { Db } from '../../db/connection.js';
import { createPluginRepo } from '../../plugins/plugin-repo.js';
import { ApiError, notImplemented, type Route } from '../router.js';

const SOURCES_NOT_IMPLEMENTED =
  `Plugin sources are not implemented in this build; this endpoint arrives with the plugin ` +
  `browser. It answers 501 rather than 404 deliberately: the route exists and is specified, so ` +
  `a client author knows to wait for it rather than going looking for a path they got wrong. ` +
  `Until then, first-party plugins are always available and a community plugin is loaded by ` +
  `giving its absolute path as a node's pluginId.`;

const firstPartyResources = () =>
  Object.values(FIRST_PARTY_PLUGINS).map((entry) => {
    const details = entry.module.details();
    return {
      id: entry.id,
      name: details.name,
      description: details.description,
      tags: details.tags,
      version: '1.0.0',
      source: 'first-party' as const,
      enabled: true,
      isStartPlugin: details.isStartPlugin === true,
      // What a dry run can promise about this node — the same classification
      // `runDryFlow` uses to decide where to stop.
      sideEffects: classifySideEffects({
        id: entry.id,
        absPath: `builtin:${entry.id}`,
        version: '1.0.0',
        details,
        module: entry.module,
      }),
      details,
    };
  });

/**
 * The installed plugins, read through `PluginRepo` rather than a second copy
 * of its SQL. One reader means one answer: a plugin that is no longer
 * installed disappears from here at exactly the moment it stops resolving
 * for flow validation, library health and the worker.
 */
const installedResources = (db: Db) =>
  createPluginRepo(db)
    .listPlugins()
    .map((row) => ({
      id: row.id,
      name: row.details.name ?? row.relPath,
      description: row.details.description ?? '',
      tags: row.details.tags ?? '',
      version: row.version,
      source: 'installed' as const,
      sourceId: row.sourceId,
      absPath: row.absPath,
      enabled: row.enabled,
      isStartPlugin: row.details.isStartPlugin === true,
      // Anything trawlarr did not write may spawn subprocesses or write files
      // directly, so `unknown` is the honest answer and is what makes a dry
      // run stop at it rather than pretend.
      sideEffects: 'unknown' as const,
      details: row.details as unknown,
    }));

export const pluginRoutes: Route[] = [
  {
    method: 'GET',
    path: '/plugins',
    handler: ({ ctx }) => [...firstPartyResources(), ...installedResources(ctx.db)],
  },

  {
    method: 'GET',
    path: '/plugins/sources',
    handler: notImplemented(SOURCES_NOT_IMPLEMENTED),
  },
  {
    method: 'POST',
    path: '/plugins/sources',
    handler: notImplemented(SOURCES_NOT_IMPLEMENTED),
  },
  {
    method: 'PUT',
    path: '/plugins/sources/:id',
    handler: notImplemented(SOURCES_NOT_IMPLEMENTED),
  },
  {
    method: 'DELETE',
    path: '/plugins/sources/:id',
    handler: notImplemented(SOURCES_NOT_IMPLEMENTED),
  },
  {
    method: 'POST',
    path: '/plugins/sources/:id/sync',
    handler: notImplemented(SOURCES_NOT_IMPLEMENTED),
  },

  {
    method: 'GET',
    path: '/plugins/:id',
    handler: ({ params, ctx }) => {
      const id = params.id!;
      const known = [...firstPartyResources(), ...installedResources(ctx.db)].find(
        (plugin) => plugin.id === id,
      );
      if (known !== undefined) return known;

      // A plugin id that is not first-party and not in the table may still
      // be an absolute path this host can load — which is exactly how a
      // community plugin is referenced today, so answering 404 for one that
      // loads fine would be wrong.
      try {
        const loaded = createPluginLoader().load(id);
        return {
          id: loaded.id,
          name: loaded.details.name,
          description: loaded.details.description,
          tags: loaded.details.tags,
          version: loaded.version,
          source: 'path' as const,
          absPath: loaded.absPath,
          enabled: true,
          isStartPlugin: loaded.details.isStartPlugin === true,
          sideEffects: classifySideEffects(loaded),
          details: loaded.details,
        };
      } catch {
        throw new ApiError(
          404,
          'plugin-not-found',
          `No plugin "${id}" is installed here, and it is not a path this host can load. ` +
            `First-party ids look like "trawlarr:execute"; an installed one looks like ` +
            `"tdarr:ffmpegCommandSetContainer" and needs its source added and synced; a ` +
            `community plugin with no source is named by its absolute path.`,
        );
      }
    },
  },
];
