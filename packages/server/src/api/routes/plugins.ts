import { classifySideEffects, createPluginLoader } from '@trawlarr/engine';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import type { Db } from '../../db/connection.js';
import {
  assertHttpsUrl,
  assertLocalSourcePath,
  PluginSourceError,
} from '../../plugins/fetch-source.js';
import { assertValidSourceSlug, PluginIdError } from '../../plugins/plugin-id.js';
import { createPluginRepo, PluginRepoError } from '../../plugins/plugin-repo.js';
import type { PluginSourceRow } from '../../plugins/plugin-repo.js';
import { PLUGIN_TRUST_CONSEQUENCE } from '../../plugins/trust.js';
import {
  ApiError,
  accepted,
  created,
  noContent,
  optionalBoolean,
  type ApiContext,
  type Route,
} from '../router.js';

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

/**
 * A plugin source as this API reports it: the row, what it has installed, and
 * where its last sync got to.
 *
 * The sync status is part of the SOURCE rather than a separate endpoint
 * because a 202'd sync has no other home: the request that started it
 * returned before it finished, so this is where a caller — the CLI polling,
 * or a UI that reconnected — reads whether it worked.
 */
const sourceResource = (ctx: ApiContext, source: PluginSourceRow) => ({
  ...source,
  installedCount: createPluginRepo(ctx.db).listPlugins(source.id).length,
  sync: ctx.pluginSyncs.status(source.id),
});

/** The one 404 for a source id nothing knows, naming what this host does know. */
const requireSource = (ctx: ApiContext, id: string): PluginSourceRow => {
  const repo = createPluginRepo(ctx.db);
  const source = repo.getSource(id);
  if (source !== null) return source;
  const known = repo
    .listSources()
    .map((row) => row.id)
    .join(', ');
  throw new ApiError(
    404,
    'source-not-found',
    `No plugin source "${id}" on this host. Known sources: ${known === '' ? '(none)' : known}.`,
  );
};

/**
 * A `PluginSourceError`'s own code, as this API's error code.
 *
 * Prefixed rather than passed through, so a client reading `code` can tell a
 * plugin-source failure from any other 400 this API returns, and namespaced
 * the same way the source rows are.
 */
const sourceErrorCode = (error: PluginSourceError): string => `source-${error.code}`;

export const pluginRoutes: Route[] = [
  {
    method: 'GET',
    path: '/plugins',
    handler: ({ ctx }) => [...firstPartyResources(), ...installedResources(ctx.db)],
  },

  {
    method: 'GET',
    path: '/plugins/sources',
    handler: ({ ctx }) =>
      createPluginRepo(ctx.db)
        .listSources()
        .map((source) => sourceResource(ctx, source)),
  },

  {
    method: 'POST',
    path: '/plugins/sources',
    handler: ({ body, ctx }) => {
      const input = (body ?? {}) as { id?: unknown; url?: unknown; path?: unknown };
      const url = typeof input.url === 'string' && input.url !== '' ? input.url : null;
      const path = typeof input.path === 'string' && input.path !== '' ? input.path : null;

      if (typeof input.id !== 'string' || input.id === '' || (url === null) === (path === null)) {
        // Both, or neither. Refused rather than resolved by precedence, for
        // the reason the CLI refuses it: an ignored field silently gives the
        // caller the OTHER one's behaviour, which is a source pointing
        // somewhere nobody asked for.
        throw new ApiError(
          400,
          'invalid-source',
          `A plugin source needs a non-empty "id" and exactly one of "url" (an https .tar.gz, ` +
            `for example https://codeload.github.com/HaveAGitGat/Tdarr_Plugins/tar.gz/master) ` +
            `or "path" (an absolute directory already on the server).`,
        );
      }

      // The slug first: a reserved or malformed name is a typo, and answering
      // it must not have touched the source table.
      try {
        assertValidSourceSlug(input.id);
      } catch (error) {
        if (error instanceof PluginIdError) {
          throw new ApiError(400, 'invalid-source-id', error.message);
        }
        throw error;
      }

      const repo = createPluginRepo(ctx.db);
      if (repo.getSource(input.id) !== null) {
        throw new ApiError(
          409,
          'source-exists',
          `A plugin source named "${input.id}" already exists here. Names are the prefix of ` +
            `every plugin id they install ("${input.id}:someName"), so two sources cannot share ` +
            `one. Remove it first, or sync it instead of adding it again.`,
        );
      }

      if (url !== null) {
        // A url that is not a url at all is a different mistake from a url
        // that is http, and the fix is different too.
        try {
          new URL(url);
        } catch {
          throw new ApiError(
            400,
            'invalid-source-url',
            `Plugin source url "${url}" is not a url. A tarball source wants a complete https ` +
              `address ending in a .tar.gz, such as a codeload.github.com link.`,
          );
        }
      }

      // Both of these are the SAME checks the syncer applies, imported from
      // it rather than restated: an https-only rule or a "does this path
      // exist" rule with two implementations is a rule with two answers.
      // Applied here so the operator learns at the moment they typed it,
      // instead of at the first sync.
      try {
        if (url !== null) assertHttpsUrl(url);
        else assertLocalSourcePath(path!);
      } catch (error) {
        if (error instanceof PluginSourceError) {
          throw new ApiError(400, sourceErrorCode(error), error.message);
        }
        throw error;
      }

      let row;
      try {
        row = repo.addSource({
          id: input.id,
          url: url ?? path!,
          // Exactly one sensible kind per field, so a caller never sends one.
          kind: url !== null ? 'tarball' : 'local',
        });
      } catch (error) {
        if (error instanceof PluginRepoError && /already exists/i.test(error.message)) {
          // A different name pointing at the same place: the plugins would be
          // installed twice under two id prefixes.
          throw new ApiError(409, 'source-exists', error.message);
        }
        if (error instanceof PluginIdError) {
          throw new ApiError(400, 'invalid-source-id', error.message);
        }
        throw error;
      }

      return created({
        ...sourceResource(ctx, row),
        // The trust decision is THIS request, and it takes effect at the
        // sync. The CLI prints this sentence; an API caller — and the UI
        // built on it — is owed the same one rather than a quieter version.
        trust: PLUGIN_TRUST_CONSEQUENCE,
        note:
          `Nothing is installed yet. POST /api/v1/plugins/sources/${row.id}/sync installs its ` +
          `plugins, and that is the request that runs their code.`,
      });
    },
  },

  {
    method: 'GET',
    path: '/plugins/sources/:id',
    handler: ({ params, ctx }) => sourceResource(ctx, requireSource(ctx, params.id!)),
  },

  {
    method: 'PUT',
    path: '/plugins/sources/:id',
    handler: ({ params, body, ctx }) => {
      const source = requireSource(ctx, params.id!);
      const enabled = optionalBoolean(body, 'enabled');
      if (enabled === undefined) {
        throw new ApiError(
          400,
          'invalid-body',
          `"enabled" is required and must be true or false. It is the only field of a plugin ` +
            `source that can be edited: a url or a name change would orphan every plugin id ` +
            `already installed from it, so those are a remove and an add.`,
        );
      }
      const repo = createPluginRepo(ctx.db);
      repo.setSourceEnabled(source.id, enabled);
      return sourceResource(ctx, repo.getSource(source.id)!);
    },
  },

  {
    method: 'DELETE',
    path: '/plugins/sources/:id',
    handler: ({ params, ctx }) => {
      const source = requireSource(ctx, params.id!);
      if (ctx.pluginSyncs.syncing().includes(source.id)) {
        throw new ApiError(
          409,
          'sync-in-progress',
          `Plugin source "${source.id}" is syncing right now. Deleting it mid-sync would leave ` +
            `the extraction it is unpacking with no rows to point at it. Wait for ` +
            `GET /api/v1/plugins/sources/${source.id} to report it is no longer running, then ` +
            `delete it.`,
        );
      }
      // `plugin.source_id` is ON DELETE CASCADE, so the installed plugins go
      // with the source — which is why this is the request that makes a flow
      // naming one of them stop resolving.
      createPluginRepo(ctx.db).removeSource(source.id);
      return noContent();
    },
  },

  {
    method: 'POST',
    path: '/plugins/sources/:id/sync',
    handler: ({ params, ctx }) => {
      const source = requireSource(ctx, params.id!);
      const request = ctx.pluginSyncs.request(source.id);
      if (!request.started) {
        throw new ApiError(
          409,
          'sync-in-progress',
          `Plugin source "${source.id}" is already syncing (run ${String(request.runId)}). Two ` +
            `syncs of one source race on the same extraction directory and on the row rewrite, ` +
            `so a second is refused rather than queued. Watch the one in flight at ` +
            `GET /api/v1/plugins/sources/${source.id}.`,
        );
      }
      // 202, not 200, and for the same reason POST /libraries/:id/scan is:
      // this fetches a tarball, unpacks it and LOADS every candidate plugin
      // to validate it — minutes against a real repository. A handler that
      // awaited it would hold the connection past every proxy's timeout, and
      // the daemon serves the UI and the worker supervisor from the same
      // process. The work continues here; the outcome is state.
      return accepted({
        accepted: true,
        sourceId: source.id,
        runId: request.runId,
        trust: PLUGIN_TRUST_CONSEQUENCE,
        note:
          `The sync was started, not performed: it fetches, unpacks and loads every candidate ` +
          `plugin to validate it, which takes minutes on a real repository. Watch ` +
          `"plugin.sync.started"/"plugin.sync.finished"/"plugin.sync.failed" on the websocket, ` +
          `or poll GET /api/v1/plugins/sources/${source.id} until "sync.running" is false and ` +
          `"sync.runId" is ${String(request.runId)}; its "sync.report" or "sync.error" is the ` +
          `result.`,
      });
    },
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
