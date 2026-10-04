import { assessRuntime } from '@trawlarr/core';
import { createLibraryRepo } from '../../db/library-repo.js';
import { createMediaFileRepo } from '../../db/media-file-repo.js';
import { createRuntimeCheckRepo } from '../../db/runtime-check-repo.js';
import { ApiError, type Route } from '../router.js';

/**
 * Files whose length does not match what the title should run.
 *
 * Reverify and Delete are not here: they are the existing
 * `POST /files/:id/requeue` and `DELETE /files/:id`, so the invariants those
 * enforce (no requeue or delete under a running job) hold for free.
 */
export const runtimeRoutes: Route[] = [
  {
    method: 'GET',
    path: '/diagnose/runtime',
    handler: ({ ctx }) => {
      const thresholds = new Map(
        createLibraryRepo(ctx.db)
          .list()
          .map((library) => [library.id, library.runtime] as const),
      );
      const items = [];
      for (const row of createRuntimeCheckRepo(ctx.db).listCandidates()) {
        const threshold = thresholds.get(row.libraryId);
        if (threshold === undefined) continue;
        const assessment = assessRuntime({
          actualMs: row.durationMs,
          expectedMs: row.expectedRuntimeMs,
          acceptedMs: row.acceptedDurationMs,
          threshold,
        });
        if (assessment === null || !assessment.flagged) continue;
        items.push({
          id: row.id,
          libraryId: row.libraryId,
          path: row.path,
          sizeBytes: row.sizeBytes,
          state: row.state,
          durationMs: row.durationMs,
          expectedMs: row.expectedRuntimeMs,
          source: row.expectedRuntimeSource,
          baselineMs: assessment.baselineMs,
          diffMs: assessment.diffMs,
        });
      }
      return { total: items.length, items };
    },
  },

  {
    method: 'POST',
    path: '/files/:id/runtime/ignore',
    handler: ({ params, ctx }) => {
      const row = createMediaFileRepo(ctx.db).getById(params.id!);
      if (row === null) {
        throw new ApiError(404, 'file-not-found', `No file with id "${params.id!}".`);
      }
      // The CURRENT length becomes the accepted one, so the file comes back
      // only if its length changes again, not because it still differs from
      // the database.
      if (!createRuntimeCheckRepo(ctx.db).accept(row.id)) {
        throw new ApiError(
          409,
          'no-duration',
          `"${row.path}" has no measured duration yet, so there is no length to accept.`,
        );
      }
      return { id: row.id, acceptedDurationMs: row.duration_ms };
    },
  },
];
