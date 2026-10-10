import { checkLibraryHealth, PAUSE_PREFIX_FLOW } from '../../daemon/library-health.js';
import {
  createLibraryRepo,
  OverlappingRootsError,
  RelativeReservedDirectoryError,
  ReservedDirectoryOverlapsRootError,
  type LibraryRecord,
  type RuntimeSourceConfig,
} from '../../db/library-repo.js';
import { createMediaFileRepo } from '../../db/media-file-repo.js';
import type { PlexConfig } from '../../library/plex-notify.js';
import { ScopeError, validateScope } from '../../scanner/scope.js';
import { explainPause } from '../../library/pause-explanation.js';
import {
  accepted,
  ApiError,
  created,
  noContent,
  optionalBoolean,
  optionalStringArray,
  requireString,
  type ApiContext,
  type Route,
} from '../router.js';

/**
 * A library as the API reports it: the row, plus WHY IT IS NOT RUNNING when
 * it is not running.
 *
 * `pausedReason` is a column Task 9 started writing and nothing surfaced. A
 * library that has silently stopped converging is indistinguishable from one
 * that has finished converging — no jobs, no errors, no output — so the
 * reason travels on every representation of a library, together with an
 * explanation that names the consequence rather than the rule
 * (`explainPause`).
 */
export const toLibraryResource = (library: LibraryRecord) => {
  const pause = explainPause(library);
  return {
    id: library.id,
    name: library.name,
    roots: library.roots,
    extensions: library.extensions,
    companionExtensions: library.companionExtensions,
    stagingDir: library.stagingDir,
    trashDir: library.trashDir,
    flowId: library.flowId,
    allowHardlinked: library.allowHardlinked,
    enabled: library.enabled,
    paused: !library.enabled,
    pausedReason: library.pausedReason,
    pausedBy: pause?.owner ?? null,
    pausedExplanation: pause?.explanation ?? null,
    userVariables: library.userVariables,
    // The token travels with the rest of the settings, as the daemon's own
    // API key and the OIDC client secret already do: every one of these
    // endpoints is authenticated, and a write-only field cannot be shown
    // back to the person editing it.
    plex: library.plex,
    // Unlike the Plex token above, the arr API key is NEVER sent back: the
    // form shows whether one is stored, and an absent `apiKey` on PATCH
    // keeps it. `hasApiKey` is what makes that distinction visible.
    runtime: {
      kind: library.runtime.kind,
      url: library.runtime.url,
      hasApiKey: library.runtime.apiKey !== '',
      percent: library.runtime.percent,
      minutes: library.runtime.minutes,
    },
    createdAt: library.createdAt,
  };
};

/**
 * The `plex` field of a PATCH: absent leaves the setting alone, explicit
 * null turns notification off, an object replaces it.
 *
 * The URL is validated here rather than at send time because a typo is a
 * configuration mistake the person is looking at right now, whereas a
 * notifier that discovers it hours later can only write it to a log.
 */
const parsePlexPatch = (patch: Record<string, unknown>): PlexConfig | null | undefined => {
  if (!('plex' in patch)) return undefined;
  if (patch.plex === null) return null;
  const value = patch.plex as Record<string, unknown>;
  const url = String(value.url ?? '').trim();
  if (url !== '') {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError(
        400,
        'invalid-plex-url',
        `"${url}" is not a URL. Give the Plex server's origin, e.g. "http://plex.lan:32400".`,
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(
        400,
        'invalid-plex-url',
        `Plex URL must be http or https, not "${parsed.protocol}".`,
      );
    }
  }
  const pathPrefix = String(value.pathPrefix ?? '').trim();
  if (pathPrefix !== '' && !pathPrefix.startsWith('/')) {
    throw new ApiError(
      400,
      'invalid-plex-path-prefix',
      `Plex library path must be absolute, as Plex itself reports it (e.g. "/data/usenet/shows"). ` +
        `Leave it empty to refresh the whole section instead.`,
    );
  }
  return {
    url,
    token: String(value.token ?? ''),
    sectionId: String(value.sectionId ?? '').trim(),
    pathPrefix: pathPrefix === '' ? null : pathPrefix,
  };
};

/**
 * A stored key is only ever sent to the address it was saved for. Without this
 * a PATCH that changed `url` and omitted `apiKey` kept the key, so anyone who
 * could call the API could point the address at a host they run and have the
 * next lookup deliver the (otherwise write-only) key to it. Moving to another
 * origin therefore drops the key unless a new one comes with it.
 */
const runtimeApiKey = (
  v: Record<string, unknown>,
  current: RuntimeSourceConfig,
  url: string,
): string => {
  if (typeof v.apiKey === 'string') return v.apiKey.trim();
  return originOf(url) === originOf(current.url) ? current.apiKey : '';
};

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/**
 * The `runtime` field of a PATCH. Fields not sent keep their stored value, so
 * a form that only edits the threshold cannot blank the address; `apiKey`
 * absent keeps the stored key (it is never shown, so a client cannot echo it).
 */
const parseRuntimePatch = (
  patch: Record<string, unknown>,
  current: RuntimeSourceConfig,
): RuntimeSourceConfig | undefined => {
  if (!('runtime' in patch)) return undefined;
  const value = patch.runtime;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'invalid-runtime', `"runtime" must be an object.`);
  }
  const v = value as Record<string, unknown>;

  const kind = 'kind' in v ? v.kind : current.kind;
  if (kind !== null && kind !== 'radarr' && kind !== 'sonarr') {
    throw new ApiError(
      400,
      'invalid-runtime',
      `runtime.kind must be "radarr", "sonarr" or null, got ${JSON.stringify(kind)}.`,
    );
  }
  const url = 'url' in v ? String(v.url ?? '').trim() : current.url;
  if (url !== '') {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError(
        400,
        'invalid-runtime-url',
        `"${url}" is not a URL. Give the address, e.g. "http://radarr.lan:7878".`,
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(
        400,
        'invalid-runtime-url',
        `Address must be http or https, not "${parsed.protocol}".`,
      );
    }
  }
  const number = (field: 'percent' | 'minutes', max: number): number => {
    if (!(field in v)) return current[field];
    const n = v[field];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max) {
      throw new ApiError(
        400,
        'invalid-runtime',
        `runtime.${field} must be a number between 0 and ${String(max)}, got ${JSON.stringify(n)}.`,
      );
    }
    return n;
  };
  return {
    kind,
    url,
    apiKey: runtimeApiKey(v, current, url),
    percent: number('percent', 100),
    minutes: number('minutes', 600),
  };
};

const requireLibrary = (ctx: ApiContext, id: string): LibraryRecord => {
  const library = createLibraryRepo(ctx.db).getById(id);
  if (library === null) {
    throw new ApiError(
      404,
      'library-not-found',
      `No library with id "${id}". List them with GET /api/v1/libraries; a library id is not its ` +
        `name.`,
    );
  }
  return library;
};

/**
 * Library creation/editing rejects a handful of misconfigurations whose
 * messages already name the consequence. They are surfaced verbatim, with
 * the status that says whether the request or the existing data is the
 * problem: an overlapping root is a CONFLICT with a library that already
 * exists (409), while a relative or root-swallowing reserved directory is
 * this request being wrong (400).
 */
const asLibraryError = (error: unknown): never => {
  if (error instanceof OverlappingRootsError) {
    throw new ApiError(409, 'overlapping-roots', error.message);
  }
  if (
    error instanceof RelativeReservedDirectoryError ||
    error instanceof ReservedDirectoryOverlapsRootError
  ) {
    throw new ApiError(400, 'invalid-library', error.message);
  }
  if (error instanceof Error && /UNIQUE constraint failed: library\.name/.test(error.message)) {
    throw new ApiError(
      409,
      'duplicate-name',
      `A library with that name already exists. Library names are unique so that "trawlarr ` +
        `status --library <name>" can never mean two different libraries.`,
    );
  }
  throw error;
};

/**
 * Re-check the library's flow immediately after anything that could change
 * the answer, so the reason a library is (or is no longer) paused is already
 * correct in the response the caller is about to read — rather than
 * appearing a tick later, on a health check they never see.
 */
const withHealth = (ctx: ApiContext, libraryId: string): LibraryRecord => {
  checkLibraryHealth({ db: ctx.db, libraryId, bus: ctx.bus });
  return requireLibrary(ctx, libraryId);
};

export const libraryRoutes: Route[] = [
  {
    method: 'GET',
    path: '/libraries',
    handler: ({ ctx }) => createLibraryRepo(ctx.db).list().map(toLibraryResource),
  },

  {
    method: 'POST',
    path: '/libraries',
    handler: ({ body, ctx }) => {
      const name = requireString(body, 'name');
      const roots = optionalStringArray(body, 'roots');
      if (roots === undefined || roots.length === 0) {
        throw new ApiError(
          400,
          'invalid-body',
          `"roots" is required and must list at least one absolute directory: a library with no ` +
            `root has nothing to scan.`,
        );
      }
      const patch = body as Record<string, unknown>;
      let library: LibraryRecord;
      try {
        library = createLibraryRepo(ctx.db).create({
          name,
          roots,
          extensions: optionalStringArray(body, 'extensions'),
          companionExtensions: optionalStringArray(body, 'companionExtensions'),
          stagingDir: (patch.stagingDir as string | null | undefined) ?? null,
          trashDir: (patch.trashDir as string | null | undefined) ?? null,
          flowId: (patch.flowId as string | null | undefined) ?? null,
          allowHardlinked: optionalBoolean(body, 'allowHardlinked'),
          nowMs: ctx.nowMs(),
        });
      } catch (error) {
        return asLibraryError(error);
      }
      // A library that exists but is not WATCHED is a library where dropping
      // a file in does nothing until the periodic rescan comes round — up to
      // an hour later, with nothing anywhere saying why. Watchers used to be
      // started once, at daemon start, over the libraries that existed then;
      // since the API is how a UI creates one, every library ever created
      // through it was unwatched until the daemon was restarted. Proved by
      // the daemon end-to-end suite, fixed here and in `syncWatchers`.
      ctx.scans.syncWatchers();
      // And the same reasoning the daemon's own startup uses: a new library
      // is walked now rather than at the next interval, because "I added my
      // library and nothing happened" is indistinguishable from broken.
      ctx.scans.request(library.id, 'startup');
      // Every online node probes the library list it was last sent; without a
      // push it never learns this library exists, and its eligibility (and
      // any claim made from it) stays based on the old list.
      ctx.nodes.pushConfigAll();

      // A brand-new library with no flow cannot converge anything, and this
      // is where it says so — in `pausedReason`, immediately, rather than
      // looking healthy until someone wonders why nothing ever runs.
      return created(toLibraryResource(withHealth(ctx, library.id)));
    },
  },

  {
    method: 'GET',
    path: '/libraries/:id',
    handler: ({ params, ctx }) => toLibraryResource(requireLibrary(ctx, params.id!)),
  },

  {
    method: 'PATCH',
    path: '/libraries/:id',
    handler: ({ params, body, ctx }) => {
      const library = requireLibrary(ctx, params.id!);
      const patch = (body ?? {}) as Record<string, unknown>;
      try {
        createLibraryRepo(ctx.db).update({
          id: library.id,
          name: patch.name === undefined ? undefined : requireString(body, 'name'),
          roots: optionalStringArray(body, 'roots'),
          extensions: optionalStringArray(body, 'extensions'),
          companionExtensions: optionalStringArray(body, 'companionExtensions'),
          stagingDir: patch.stagingDir as string | null | undefined,
          trashDir: patch.trashDir as string | null | undefined,
          flowId: patch.flowId as string | null | undefined,
          allowHardlinked: optionalBoolean(body, 'allowHardlinked'),
          userVariables: patch.userVariables as Record<string, string> | undefined,
          plex: parsePlexPatch(patch),
          runtime: parseRuntimePatch(patch, library.runtime),
        });
      } catch (error) {
        return asLibraryError(error);
      }
      const after = withHealth(ctx, library.id);

      // Unconditional, because it is idempotent: `syncWatchers` re-watches
      // only when this library's roots or reserved directories actually
      // changed, and moving a root without moving the watch leaves the
      // daemon watching a directory nothing will ever appear in.
      ctx.scans.syncWatchers();

      // A scan, on the other hand, only when what this library must contain
      // changed — new roots, or a different flow. Both are re-evaluations,
      // and both happen now rather than at the next periodic rescan; a walk
      // of a 100,000-file library is not the right cost for renaming one.
      const rootsChanged = JSON.stringify(after.roots) !== JSON.stringify(library.roots);
      if (rootsChanged || after.flowId !== library.flowId) {
        ctx.scans.request(library.id, 'manual');
      }
      // Moved roots map to different node paths: a node must re-probe them
      // before it is claimed for this library again.
      ctx.nodes.pushConfigAll();
      return toLibraryResource(after);
    },
  },

  {
    method: 'DELETE',
    path: '/libraries/:id',
    handler: ({ params, ctx }) => {
      requireLibrary(ctx, params.id!);
      createLibraryRepo(ctx.db).remove(params.id!);
      // Its watch outlives the row otherwise, and every event it delivers
      // asks for a scan of a library id `scanLibrary` refuses by name.
      ctx.scans.syncWatchers();
      ctx.nodes.pushConfigAll();
      return noContent();
    },
  },

  {
    method: 'POST',
    path: '/libraries/:id/scan',
    handler: ({ params, body, ctx }) => {
      const library = requireLibrary(ctx, params.id!);
      const requested = optionalStringArray(body, 'paths');

      // 202, not 200: a scan of a real library takes minutes, and holding an
      // HTTP connection open for it times out every proxy in the path. The
      // scan's progress arrives on the websocket; its result is in the
      // library's stats afterwards.
      const note =
        `The scan was queued, not performed. Watch "scan.progress"/"scan.finished" on the ` +
        `websocket, or poll GET /api/v1/libraries/${library.id}/stats.`;

      if (requested === undefined) {
        ctx.scans.request(library.id, 'manual');
        return accepted({ accepted: true, libraryId: library.id, mode: 'full' as const, note });
      }

      // An empty list is refused rather than read as "everything": a caller
      // that built its list from nothing would otherwise trigger the full
      // walk it was written to avoid.
      if (requested.length === 0) {
        throw new ApiError(
          400,
          'invalid-scope',
          `"paths" is empty. Omit it to scan the whole library, or name at least one path.`,
        );
      }
      let paths: string[];
      try {
        paths = validateScope({ library, paths: requested });
      } catch (error) {
        if (error instanceof ScopeError) throw new ApiError(400, 'invalid-scope', error.message);
        throw error;
      }
      ctx.scans.request(library.id, 'notify', paths);
      return accepted({
        accepted: true,
        libraryId: library.id,
        mode: 'scoped' as const,
        paths,
        note,
      });
    },
  },

  {
    method: 'GET',
    path: '/libraries/:id/stats',
    handler: ({ params, ctx }) => {
      const library = requireLibrary(ctx, params.id!);
      const repo = createMediaFileRepo(ctx.db);
      const byState = repo.countsByState(library.id);
      const total = Object.values(byState).reduce((sum, count) => sum + count, 0);
      const missing = repo.missingCount(library.id);

      // FLOORED, NEVER ROUNDED UP, and 100 is reserved for `good === total`
      // exactly: a library with files still queued reading "100% converged"
      // is the one number this project's counter-honesty rule cannot let
      // overstate. Same computation the CLI's `status` prints.
      const convergedPercent = total === 0 ? 0 : Math.floor((byState.good / total) * 100);

      return {
        libraryId: library.id,
        total,
        byState,
        reviewHeld: repo.reviewHeldCount(library.id),
        good: byState.good,
        missing,
        convergedPercent,
        paused: !library.enabled,
        pausedReason: library.pausedReason,
        pausedExplanation: explainPause(library)?.explanation ?? null,
        scanning: ctx.scans.scanning().includes(library.id),
      };
    },
  },

  {
    method: 'POST',
    path: '/libraries/:id/pause',
    handler: ({ params, body, ctx }) => {
      const library = requireLibrary(ctx, params.id!);
      const reason = ((body ?? {}) as Record<string, unknown>).reason;
      const text =
        typeof reason === 'string' && reason !== ''
          ? reason
          : 'paused through the API, with no reason given';
      // The `operator: ` prefix is what tells `checkLibraryHealth` this pause
      // belongs to a human and must never be lifted automatically, however
      // healthy the flow becomes.
      createLibraryRepo(ctx.db).pause(library.id, `operator: ${text}`);
      ctx.bus.emit({ type: 'library.paused', libraryId: library.id, reason: `operator: ${text}` });
      return toLibraryResource(requireLibrary(ctx, library.id));
    },
  },

  {
    method: 'POST',
    path: '/libraries/:id/resume',
    handler: ({ params, ctx }) => {
      const library = requireLibrary(ctx, params.id!);

      if (library.pausedReason?.startsWith(PAUSE_PREFIX_FLOW) === true) {
        // REFUSED, with the reason quoted in full — which is what names the
        // missing plugin. Resuming a library into a flow that cannot run
        // does not produce one legible error; it produces one failure per
        // file, ten thousand of them, each identical and none of them the
        // actual problem (spec 6.5).
        throw new ApiError(
          409,
          'flow-invalid',
          `Library "${library.name}" cannot be resumed: its flow still cannot be run. ` +
            `${library.pausedReason.slice(PAUSE_PREFIX_FLOW.length)} Resuming would not fix ` +
            `that — it would hand every file in the library to a flow that fails on all of ` +
            `them, turning one legible problem into one failure per file. Fix the flow (or ` +
            `attach a different one with PATCH /api/v1/libraries/${library.id}); the pause ` +
            `clears itself as soon as the flow is runnable.`,
        );
      }

      createLibraryRepo(ctx.db).resume(library.id);
      ctx.bus.emit({ type: 'library.resumed', libraryId: library.id });
      // Re-checked immediately: if the flow is ALSO broken, the library is
      // paused again right here with the flow's own reason, so the response
      // tells the truth instead of reporting a resume that achieved nothing.
      const after = withHealth(ctx, library.id);
      void ctx.supervisor.tick();
      return toLibraryResource(after);
    },
  },
];
