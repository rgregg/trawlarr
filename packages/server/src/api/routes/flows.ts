import { FlowValidationError, validateFlowDefinition, type FlowDefinition } from '@trawlarr/core';
import { checkAllLibraries } from '../../daemon/library-health.js';
import { createFlowRepo, type FlowRecord } from '../../db/flow-repo.js';
import { createFlowVersionRepo, type FlowVersionRecord } from '../../db/flow-version-repo.js';
import { createLibraryRepo } from '../../db/library-repo.js';
import { createNodeCapabilityResolver } from '../../flow/node-capabilities.js';
import { createPluginRegistry } from '../../plugins/registry.js';
import { dryRunFlow, DryRunInputError } from '../../flow/dry-run.js';
import { buildFromTemplate, FLOW_TEMPLATES, UnknownTemplateError } from '../../flow/templates.js';
import {
  ApiError,
  created,
  noContent,
  parsePaging,
  requireString,
  type ApiContext,
  type Route,
} from '../router.js';

const toFlowResource = (flow: FlowRecord) => ({
  id: flow.id,
  name: flow.name,
  description: flow.description,
  tags: flow.tags,
  definition: flow.definition,
  // The hash IS the flow's version: every file whose ledger recorded the old
  // one is stale the moment a definition changes, which is why it travels
  // with every representation rather than being computed by clients.
  definitionHash: flow.definitionHash,
  createdAt: flow.createdAt,
  updatedAt: flow.updatedAt,
});

const requireFlow = (ctx: ApiContext, id: string): FlowRecord => {
  const flow = createFlowRepo(ctx.db).getById(id);
  if (flow === null) throw new ApiError(404, 'flow-not-found', `No flow with id "${id}".`);
  return flow;
};

/**
 * A version that both exists AND belongs to the flow the URL names — a
 * version id from a DIFFERENT flow must 404 here rather than restore or
 * display someone else's history under this flow's id.
 */
const requireFlowVersion = (
  ctx: ApiContext,
  flowId: string,
  versionId: string,
): FlowVersionRecord => {
  const version = createFlowVersionRepo(ctx.db).get(versionId);
  if (version === null || version.flowId !== flowId) {
    throw new ApiError(
      404,
      'flow-version-not-found',
      `No version "${versionId}" on flow "${flowId}".`,
    );
  }
  return version;
};

/**
 * The most recent version row for a flow — the one whose hash matches the
 * live `flow` row right now, and the only entry `isCurrent` should ever mark
 * true. Determined by id rather than by hash: hashes are deliberately not
 * unique (publish A, then B, then A again), so only "newest row" identifies
 * "current" unambiguously, and it must hold regardless of which page of the
 * listing that row happens to fall on.
 */
const newestVersionId = (ctx: ApiContext, flowId: string): string | null => {
  const { items } = createFlowVersionRepo(ctx.db).list({ flowId, limit: 1, offset: 0 });
  return items[0]?.id ?? null;
};

const requireDefinition = (body: unknown): FlowDefinition => {
  const definition = (body as Record<string, unknown> | null | undefined)?.definition;
  if (definition === null || typeof definition !== 'object') {
    throw new ApiError(
      400,
      'invalid-body',
      `"definition" is required and must be a flow definition object ({nodes, edges}).`,
    );
  }
  return definition as FlowDefinition;
};

/**
 * A definition the executor will not run is a 400 with EVERY problem listed,
 * not just the first.
 *
 * A flow usually has more than one thing wrong with it, and a validator that
 * reports one per round trip turns fixing a flow into a guessing game. The
 * messages are the validator's own — they name the consequence, which is the
 * only reason they are worth reading.
 */
const asFlowValidationError = (error: unknown): never => {
  if (error instanceof FlowValidationError) {
    throw new ApiError(
      400,
      'flow-invalid',
      `This flow was NOT stored — trawlarr will not run it (${error.problems.length} ` +
        `problem(s)): ${error.problems.map((problem) => problem.message).join(' ')}`,
    );
  }
  if (error instanceof Error && /UNIQUE constraint failed: flow\.name/.test(error.message)) {
    throw new ApiError(409, 'duplicate-name', `A flow with that name already exists.`);
  }
  throw error;
};

/**
 * `buildFromTemplate`, with the one failure a caller can cause turned into a
 * 400 that names the templates that DO exist — a typo'd template id is the
 * most likely way this endpoint is used wrongly, and a 500 would report it as
 * the server's fault.
 */
const fromTemplate = (templateId: string, values: unknown): FlowDefinition => {
  try {
    return buildFromTemplate({
      templateId,
      values: (values as Record<string, string> | undefined) ?? {},
    });
  } catch (error) {
    if (error instanceof UnknownTemplateError) {
      throw new ApiError(400, 'unknown-template', error.message);
    }
    throw error;
  }
};

/**
 * The one door through which a flow's live definition ever changes:
 * `update`, then the two consequences that keep the rest of the system
 * honest about it. `PUT /flows/:id` and `POST
 * /flows/:id/versions/:versionId/restore` both publish through here — a
 * restore is a publish of an OLD definition, not a special case, so it must
 * run every step a normal edit runs. Skipping the rescan step would leave a
 * library claiming convergence under a definition it never actually ran.
 */
const publishFlow = (
  ctx: ApiContext,
  input: { id: string; definition: FlowDefinition; note?: string },
): FlowRecord => {
  const updated = createFlowRepo(ctx.db).update({
    id: input.id,
    definition: input.definition,
    nowMs: ctx.nowMs(),
    note: input.note,
  });
  // A flow edit can make a paused library runnable, or an attached flow
  // unrunnable. Re-checked here so the library's `pausedReason` is correct
  // immediately rather than at the next daemon tick.
  checkAllLibraries({ db: ctx.db, bus: ctx.bus });
  // The edit also changed what "converged" MEANS for every library using
  // this flow: their files' signatures no longer match the flow's hash. Only
  // a scan re-derives that (see `scanLibrary`'s rule 7), so one is requested
  // per affected library rather than leaving a library visibly "100%
  // converged" under a flow it has never been run through.
  for (const library of createLibraryRepo(ctx.db).list()) {
    if (library.flowId === updated.id) ctx.scans.request(library.id, 'manual');
  }
  return updated;
};

export const flowRoutes: Route[] = [
  {
    method: 'GET',
    path: '/flows',
    handler: ({ ctx }) => createFlowRepo(ctx.db).list().map(toFlowResource),
  },

  {
    method: 'POST',
    path: '/flows',
    handler: ({ body, ctx }) => {
      const name = requireString(body, 'name');
      const patch = body as Record<string, unknown>;
      // A template in place of a definition, never as well as one: a caller
      // that sent both would otherwise get whichever this code happened to
      // prefer, and would find out which from the stored flow rather than
      // from the response.
      const definition =
        typeof patch.templateId === 'string'
          ? fromTemplate(patch.templateId, patch.templateValues)
          : requireDefinition(body);
      try {
        const flow = createFlowRepo(ctx.db).create({
          name,
          description: typeof patch.description === 'string' ? patch.description : undefined,
          tags: typeof patch.tags === 'string' ? patch.tags : undefined,
          definition,
          nowMs: ctx.nowMs(),
        });
        return created(toFlowResource(flow));
      } catch (error) {
        return asFlowValidationError(error);
      }
    },
  },

  /**
   * Listed BEFORE `/flows/:id` for a reader's sake only — the router matches
   * by specificity, so a flow whose id is literally "templates" is not what
   * this returns either way.
   */
  {
    method: 'GET',
    path: '/flows/templates',
    handler: () =>
      FLOW_TEMPLATES.map(({ id, name, description, parameters }) => ({
        id,
        name,
        description,
        parameters,
      })),
  },

  /**
   * Listed near the other literal `/flows/...` routes for a reader's sake —
   * NOT because registration order matters. `createRouter` (see
   * `router.ts`) picks among candidates whose SEGMENT COUNT matches the
   * request first, then picks the candidate with the most literal segments
   * among those; declaration order only breaks a tie between two patterns
   * with the SAME literal count, which cannot happen here. This route has
   * four segments (`flows`, `versions`, `by-hash`, `:hash`) and its second
   * segment is the literal `versions`, so it can never be matched by
   * `/flows/:id/versions/:versionId` (whose second segment is a param but
   * whose THIRD segment must literally equal `versions`) or by `/flows/:id`
   * (two segments, a different length entirely). There is no length or
   * position at which the two patterns compete.
   */
  {
    method: 'GET',
    path: '/flows/versions/by-hash/:hash',
    handler: ({ params, query, ctx }) => {
      // `flowId` is optional but the web UI always sends it: a hash is a pure
      // function of the definition, so two flows with the same graph share
      // one, and an unscoped lookup can hand a job on flow A a version of
      // flow B — which the restore button would then republish, re-queueing a
      // library the user was never looking at.
      const flowId = query.get('flowId') ?? undefined;
      const version = createFlowVersionRepo(ctx.db).byHash({ hash: params.hash!, flowId });
      if (version === null) {
        throw new ApiError(
          404,
          'version-not-recorded',
          `No version was ever recorded with hash "${params.hash!}"` +
            (flowId === undefined ? '' : ` for flow "${flowId}"`) +
            ` — it may predate flow versioning, or the hash may simply be wrong.`,
        );
      }
      return version;
    },
  },

  /**
   * The version equivalent of `/flows/versions/by-hash/:hash` above: reached
   * by a caller that has a version id but not the flow it belongs to — the
   * web UI's job detail screen, which stores only `flowHash` on a job row
   * and resolves it through the by-hash route to get here (see
   * `describeFlowVersion` in `packages/web/src/screens/jobs/job-detail-model.ts`).
   * `GET /flows/:id/versions/:versionId` above stays the route for a caller
   * that already has the flow (`FlowDetail.tsx`'s History section); this one
   * exists because that caller doesn't, not as a shortcut for one that does.
   *
   * SAME SPECIFICITY REASONING AS THE by-hash ROUTE, one segment shorter:
   * this pattern's three segments are `flows`, the literal `versions`, and
   * `:versionId`. `/flows/:id` is two segments — never a candidate together.
   * `/flows/:id/versions` is also three segments, but its literal `versions`
   * sits at position 2, not position 1 — for a concrete request the two
   * patterns only tie when the actual second AND third segments are both
   * literally `versions` (a flow whose id is literally "versions"), the same
   * class of edge case `/flows/templates` above already accepts for a flow
   * id of "templates" rather than guarding against it.
   */
  {
    method: 'GET',
    path: '/flows/versions/:versionId',
    handler: ({ params, ctx }) => {
      const version = createFlowVersionRepo(ctx.db).get(params.versionId!);
      if (version === null) {
        throw new ApiError(
          404,
          'flow-version-not-found',
          `No version with id "${params.versionId!}".`,
        );
      }
      return version;
    },
  },

  {
    method: 'GET',
    path: '/flows/:id',
    handler: ({ params, ctx }) => toFlowResource(requireFlow(ctx, params.id!)),
  },

  {
    method: 'GET',
    path: '/flows/:id/versions',
    handler: ({ params, query, ctx }) => {
      const flow = requireFlow(ctx, params.id!);
      const { limit, offset } = parsePaging(query);
      const page = createFlowVersionRepo(ctx.db).list({ flowId: flow.id, limit, offset });
      const currentId = newestVersionId(ctx, flow.id);
      return {
        total: page.total,
        limit,
        offset,
        items: page.items.map((item) => ({ ...item, isCurrent: item.id === currentId })),
      };
    },
  },

  {
    method: 'GET',
    path: '/flows/:id/versions/:versionId',
    handler: ({ params, ctx }) => requireFlowVersion(ctx, params.id!, params.versionId!),
  },

  {
    method: 'POST',
    path: '/flows/:id/versions/:versionId/restore',
    handler: ({ params, ctx }) => {
      const flow = requireFlow(ctx, params.id!);
      const version = requireFlowVersion(ctx, flow.id, params.versionId!);
      // Restoring publishes the OLD definition as a brand-new version — the
      // ledger is append-only, so this never rewrites or removes anything;
      // it just makes the past the present again, with a note saying so.
      // Revalidated on the way in like any other publish: a plugin the old
      // definition named may have been uninstalled since it last ran.
      let updated: FlowRecord;
      try {
        updated = publishFlow(ctx, {
          id: flow.id,
          definition: version.definition,
          note: `Restored from ${version.definitionHash}`,
        });
      } catch (error) {
        return asFlowValidationError(error);
      }
      return toFlowResource(updated);
    },
  },

  {
    method: 'PUT',
    path: '/flows/:id',
    handler: ({ params, body, ctx }) => {
      const flow = requireFlow(ctx, params.id!);
      const patch = body as Record<string, unknown>;
      let updated: FlowRecord;
      try {
        updated = publishFlow(ctx, {
          id: flow.id,
          definition: requireDefinition(body),
          note: typeof patch.note === 'string' ? patch.note : undefined,
        });
      } catch (error) {
        return asFlowValidationError(error);
      }
      return toFlowResource(updated);
    },
  },

  {
    method: 'DELETE',
    path: '/flows/:id',
    handler: ({ params, ctx }) => {
      const flow = requireFlow(ctx, params.id!);
      createFlowRepo(ctx.db).remove(flow.id);
      // `library.flow_id` is ON DELETE SET NULL, so any library using this
      // flow is now attached to nothing — which stops it converging. The
      // health check writes that as the library's own stated pause reason,
      // so an operator finds out from the library rather than from silence.
      checkAllLibraries({ db: ctx.db, bus: ctx.bus });
      return noContent();
    },
  },

  {
    method: 'POST',
    path: '/flows/validate',
    handler: ({ body, ctx }) => {
      const definition = requireDefinition(body);
      // 200 with `ok: false` — NOT an error status. The caller asked a
      // question ("would you run this?"), and got the answer; nothing was
      // stored either way. A 4xx here would make an editor's live validation
      // indistinguishable from a broken request.
      // The same resolver `createFlowRepo` stores through, registry and all:
      // an editor asking "would you run this?" about a flow naming an
      // installed plugin must get the answer the save would give.
      const problems = validateFlowDefinition(
        definition,
        createNodeCapabilityResolver({ registry: createPluginRegistry(ctx.db) }),
      );
      return {
        ok: problems.length === 0,
        problems: problems.map((problem) => ({ code: problem.code, message: problem.message })),
        stored: false,
      };
    },
  },

  {
    method: 'POST',
    path: '/flows/:id/dry-run',
    handler: async ({ params, body, ctx }) => {
      const flow = requireFlow(ctx, params.id!);
      const fileId = requireString(body, 'fileId');
      const binaries = ctx.settings.getBinaries();
      try {
        return await dryRunFlow({
          db: ctx.db,
          flowId: flow.id,
          fileId,
          ffmpegPath: binaries.ffmpeg,
          ffprobePath: binaries.ffprobe,
          nowMs: ctx.nowMs,
        });
      } catch (error) {
        if (error instanceof DryRunInputError) {
          throw new ApiError(400, 'dry-run-input', error.message);
        }
        throw error;
      }
    },
  },
];
