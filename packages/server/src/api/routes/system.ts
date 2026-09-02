import { execFile } from 'node:child_process';
import type { ScheduleConfig } from '@trawlarr/core';
import { envProvenance } from '../../config/env-settings.js';
import { createLibraryRepo } from '../../db/library-repo.js';
import { SettingValidationError } from '../../db/settings-repo.js';
import { sweepLibraryTrash } from '../../library/trash-sweep.js';
import { forgetMissing } from '../../scanner/forget-missing.js';
import { reapStalled, StaleThresholdTooShortError } from '../../worker/reap-stalled.js';
import {
  ApiError,
  optionalBoolean,
  optionalNumber,
  optionalStringArray,
  type ApiContext,
  type Route,
} from '../router.js';

/**
 * Can this configured binary be spawned at all?
 *
 * This is a CHECK OF A CONFIGURED PATH, nothing more — hence `resolved` in
 * the response rather than anything suggesting a capability probe. It says
 * "running `<path> -version` worked"; it says nothing about which encoders
 * that ffmpeg was built with, and hardware in trawlarr is DECLARED by the
 * operator, never detected.
 */
const spawnCheck = async (path: string): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    const child = execFile(path, ['-version'], { timeout: 5_000 }, (error) => {
      resolve(error === null);
    });
    child.on('error', () => {
      resolve(false);
    });
  });

const binariesReport = async (
  ctx: ApiContext,
): Promise<Record<string, { path: string; resolved: boolean }>> => {
  const check = ctx.checkBinary ?? spawnCheck;
  const binaries = ctx.settings.getBinaries();
  const [ffmpeg, ffprobe] = await Promise.all([check(binaries.ffmpeg), check(binaries.ffprobe)]);
  return {
    ffmpeg: { path: binaries.ffmpeg, resolved: ffmpeg },
    ffprobe: { path: binaries.ffprobe, resolved: ffprobe },
  };
};

const asSettingError = (error: unknown): never => {
  if (error instanceof SettingValidationError) {
    // The repo's messages are already written for a human, and they name the
    // exact field and the value it rejected.
    throw new ApiError(400, 'invalid-setting', error.message);
  }
  throw error;
};

const publicAuth = (auth: ReturnType<ApiContext['settings']['getAuth']>) => ({
  oidcEnabled: auth.oidcEnabled,
  oidcIssuer: auth.oidcIssuer,
  oidcClientId: auth.oidcClientId,
  oidcClientSecret: auth.oidcClientSecret,
  oidcRedirectUri: auth.oidcRedirectUri,
  oidcScopes: auth.oidcScopes,
  oidcDisplayName: auth.oidcDisplayName,
});

const readSettings = (ctx: ApiContext) => ({
  // The API key is returned to a caller who already proved they hold it:
  // this endpoint is not reachable without it. Withholding it here would
  // mean the UI could not show an operator the key to paste into a script,
  // which is exactly the "no privileged path" property spec 3.5 requires.
  daemon: ctx.settings.getDaemon(),
  binaries: ctx.settings.getBinaries(),
  scan: ctx.settings.getScan(),
  hardware: ctx.settings.getHardware(),
  // `oidcClientSecret` follows the same "no privileged path" reasoning as
  // the API key above: whoever configured the OIDC provider already knows
  // it, and an operator reviewing this daemon's config needs to see what it
  // currently holds. `sessionSecret` is different in kind and is never
  // included — it is this daemon's own cookie-signing key, has no
  // legitimate reason to leave the server, and disclosing it would let any
  // caller mint a session for any account.
  auth: publicAuth(ctx.settings.getAuth()),
  environment: envProvenance({
    settings: ctx.settings,
    env: process.env,
    applications: ctx.envApplications,
  }),
});

const librariesFor = (ctx: ApiContext, libraryId: unknown) => {
  const repo = createLibraryRepo(ctx.db);
  if (libraryId === undefined || libraryId === null) return repo.list();
  if (typeof libraryId !== 'string') {
    throw new ApiError(400, 'invalid-body', `"libraryId" must be a string when present.`);
  }
  const library = repo.getById(libraryId);
  if (library === null) {
    throw new ApiError(404, 'library-not-found', `No library with id "${libraryId}".`);
  }
  return [library];
};

export const systemRoutes: Route[] = [
  {
    method: 'GET',
    path: '/system/health',
    // The ONLY anonymous route. A container health check must not need the
    // secret, and this endpoint reveals nothing an unauthenticated caller
    // could not learn by observing that the port is open.
    anonymous: true,
    handler: ({ ctx }) => ({
      status: 'ok',
      version: ctx.version,
      schemaVersion: ctx.schemaVersion,
    }),
  },

  {
    method: 'GET',
    path: '/system/version',
    handler: async ({ ctx }) => ({
      version: ctx.version,
      schemaVersion: ctx.schemaVersion,
      // Reported as null, deliberately. Spec 2.10 defines a contract level a
      // plugin can require; trawlarr does not implement version reporting
      // yet, and claiming a level it does not implement — to make a client's
      // warning go away — would make every compatibility decision downstream
      // a guess against a number nobody honoured.
      contractLevel: null,
      note:
        `contractLevel is null because trawlarr does not implement plugin contract-version ` +
        `reporting yet (spec 2.10). It is reported as null rather than as a number, because a ` +
        `client that reads a level trawlarr does not honour would silently enable plugins this ` +
        `build cannot run correctly.`,
      binaries: await binariesReport(ctx),
      // What the startup preflight found, reported rather than acted on:
      // each entry is a hardware type this node DECLARES and whose encoder
      // it could not be shown to have. Empty is the healthy answer, and the
      // one to assert in a deployment check. Note the asymmetry with
      // `binaries` above — that says a path can be spawned; this says a
      // declaration was checked against what that binary can really do.
      hardware: ctx.hardwareFindings,
    }),
  },

  {
    method: 'GET',
    path: '/system/settings',
    handler: ({ ctx }) => readSettings(ctx),
  },

  {
    method: 'PATCH',
    path: '/system/settings',
    handler: ({ body, ctx }) => {
      if (body === undefined || body === null || typeof body !== 'object') {
        throw new ApiError(
          400,
          'invalid-body',
          `Send an object with any of "daemon", "binaries", "scan", "hardware" or "auth"; each ` +
            `is a partial patch of that settings group.`,
        );
      }
      const patch = body as Record<string, unknown>;
      try {
        if (patch.daemon !== undefined) ctx.settings.setDaemon(patch.daemon as never);
        if (patch.binaries !== undefined) ctx.settings.setBinaries(patch.binaries as never);
        if (patch.scan !== undefined) ctx.settings.setScan(patch.scan as never);
        if (patch.hardware !== undefined) ctx.settings.setHardware(patch.hardware as never);
        // `sessionSecret` is not a patchable field: it is never returned by
        // `readSettings` above, so there is nothing for a client to echo
        // back, and accepting one here would let a caller overwrite the
        // cookie-signing key with a value of their choosing.
        if (patch.auth !== undefined) {
          const authPatch = patch.auth as Record<string, unknown>;
          if ('sessionSecret' in authPatch) {
            throw new ApiError(
              400,
              'invalid-body',
              `"auth.sessionSecret" cannot be set through this endpoint.`,
            );
          }
          ctx.settings.setAuth(authPatch as never);
        }
      } catch (error) {
        asSettingError(error);
      }
      return readSettings(ctx);
    },
  },

  {
    method: 'GET',
    path: '/system/schedule',
    handler: ({ ctx }) => ctx.settings.getSchedule(),
  },

  {
    method: 'PUT',
    path: '/system/schedule',
    handler: async ({ body, ctx }) => {
      try {
        ctx.settings.setSchedule(body as ScheduleConfig);
      } catch (error) {
        asSettingError(error);
      }
      // A schedule change that only took effect at the next timer tick would
      // make the UI's worker strip lie for up to a whole poll interval.
      await ctx.supervisor.tick();
      return ctx.settings.getSchedule();
    },
  },

  {
    method: 'POST',
    path: '/system/maintenance/reap',
    handler: ({ body, ctx }) => {
      const hours = optionalNumber(body, 'staleAfterHours');
      const libraries = librariesFor(ctx, (body as Record<string, unknown> | null)?.libraryId);
      try {
        return reapStalled({
          db: ctx.db,
          nowMs: ctx.nowMs(),
          staleAfterMs: hours === undefined ? undefined : hours * 60 * 60 * 1000,
          libraryIds:
            (body as Record<string, unknown> | null)?.libraryId === undefined
              ? undefined
              : libraries.map((library) => library.id),
          dryRun: optionalBoolean(body, 'dryRun'),
        });
      } catch (error) {
        if (error instanceof StaleThresholdTooShortError) {
          throw new ApiError(400, 'invalid-body', error.message);
        }
        throw error;
      }
    },
  },

  {
    method: 'POST',
    path: '/system/maintenance/trash-purge',
    handler: async ({ body, ctx }) => {
      const libraries = librariesFor(ctx, (body as Record<string, unknown> | null)?.libraryId);
      const days = optionalNumber(body, 'days');
      const dryRun = optionalBoolean(body, 'dryRun');
      const sweeps = [];
      for (const library of libraries) {
        // Sequential, not Promise.all: each sweep walks a directory and
        // unlinks files, and running every library's sweep at once on a
        // NAS is how a maintenance call becomes an IO storm.
        sweeps.push(
          await sweepLibraryTrash({ db: ctx.db, library, days, nowMs: ctx.nowMs(), dryRun }),
        );
      }
      return { sweeps };
    },
  },

  {
    method: 'POST',
    path: '/system/maintenance/forget',
    handler: async ({ body, ctx }) => {
      const fileIds = optionalStringArray(body, 'fileIds');
      const missing = optionalBoolean(body, 'missing');
      const byFile = fileIds !== undefined && fileIds.length > 0;

      // The same rule the CLI enforces, for the same reason: this is the one
      // operation that destroys a record, so it is never invoked by
      // omission. `forgetMissing` with neither would sweep every missing row
      // in every library.
      if (!byFile && missing !== true) {
        throw new ApiError(
          400,
          'invalid-body',
          `Name what to forget: "missing": true (every row whose file has been confirmed gone; ` +
            `add "libraryId" to scope it), or "fileIds": ["…"]. Forgetting discards a row's ` +
            `ledger and its whole job history permanently, so it is never inferred from an ` +
            `empty request.`,
        );
      }
      if (byFile && missing === true) {
        throw new ApiError(
          400,
          'invalid-body',
          `Use either "fileIds" or "missing": true, not both — they mean different scopes, and ` +
            `guessing which one you meant would delete the wrong rows.`,
        );
      }

      const libraries = librariesFor(ctx, (body as Record<string, unknown> | null)?.libraryId);
      const results = [];
      for (const library of libraries) {
        results.push({
          libraryId: library.id,
          libraryName: library.name,
          summary: await forgetMissing({
            db: ctx.db,
            library,
            fileIds: byFile ? fileIds : undefined,
            includeTerminal: optionalBoolean(body, 'includeTerminal'),
            dryRun: optionalBoolean(body, 'dryRun'),
          }),
        });
      }
      return { results };
    },
  },
];
