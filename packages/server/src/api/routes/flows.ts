import { FlowValidationError, validateFlowDefinition, type FlowDefinition } from '@trawlarr/core';
import { checkAllLibraries } from '../../daemon/library-health.js';
import { createFlowRepo, type FlowRecord } from '../../db/flow-repo.js';
import { createLibraryRepo } from '../../db/library-repo.js';
import { createNodeCapabilityResolver } from '../../flow/node-capabilities.js';
import { dryRunFlow, DryRunInputError } from '../../flow/dry-run.js';
import {
  ApiError,
  created,
  noContent,
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
      const definition = requireDefinition(body);
      const patch = body as Record<string, unknown>;
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

  {
    method: 'GET',
    path: '/flows/:id',
    handler: ({ params, ctx }) => toFlowResource(requireFlow(ctx, params.id!)),
  },

  {
    method: 'PUT',
    path: '/flows/:id',
    handler: ({ params, body, ctx }) => {
      const flow = requireFlow(ctx, params.id!);
      let updated: FlowRecord;
      try {
        updated = createFlowRepo(ctx.db).update({
          id: flow.id,
          definition: requireDefinition(body),
          nowMs: ctx.nowMs(),
        });
      } catch (error) {
        return asFlowValidationError(error);
      }
      // A flow edit can make a paused library runnable, or an attached flow
      // unrunnable. Re-checked here so the library's `pausedReason` is
      // correct immediately rather than at the next daemon tick.
      checkAllLibraries({ db: ctx.db, bus: ctx.bus });
      // The edit also changed what "converged" MEANS for every library using
      // this flow: their files' signatures no longer match the flow's hash.
      // Only a scan re-derives that (see `scanLibrary`'s rule 7), so one is
      // requested per affected library rather than leaving a library visibly
      // "100% converged" under a flow it has never been run through.
      for (const library of createLibraryRepo(ctx.db).list()) {
        if (library.flowId === updated.id) ctx.scans.request(library.id, 'manual');
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
      void ctx;
      const definition = requireDefinition(body);
      // 200 with `ok: false` — NOT an error status. The caller asked a
      // question ("would you run this?"), and got the answer; nothing was
      // stored either way. A 4xx here would make an editor's live validation
      // indistinguishable from a broken request.
      const problems = validateFlowDefinition(definition, createNodeCapabilityResolver());
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
