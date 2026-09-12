import { unlink } from 'node:fs/promises';
import type { FileState } from '@trawlarr/core';
import { createJobRepo } from '../../db/job-repo.js';
import { ALL_STATES, createMediaFileRepo, type MediaFileRow } from '../../db/media-file-repo.js';
import { ApiError, optionalNumber, parsePaging, type ApiContext, type Route } from '../router.js';

/**
 * The range `POST /files/:id/priority` accepts. `media_file.priority` is an
 * ordering key read by `claimNext` (`priority DESC, discovered_at ASC`);
 * these bounds keep an operator's nudge a nudge.
 */
const PRIORITY_MIN = -100;
const PRIORITY_MAX = 100;

/**
 * A media file row as the API reports it: camel-cased, with `probe_json`
 * left OUT of listings.
 *
 * A probe is tens of kilobytes of JSON per file; including it in a page of
 * 500 rows turns a listing into a multi-megabyte response for data the list
 * view never renders. The detail endpoint returns it, because that is where
 * someone actually asked for one file.
 */
const toFileResource = (row: MediaFileRow) => ({
  id: row.id,
  libraryId: row.library_id,
  path: row.path,
  container: row.container,
  sizeBytes: row.size_bytes,
  originalSizeBytes: row.original_size_bytes,
  mtimeMs: row.mtime_ms,
  videoCodec: row.video_codec,
  audioCodec: row.audio_codec,
  resolution: row.resolution,
  durationMs: row.duration_ms,
  bitrate: row.bitrate,
  state: row.state,
  signature: row.signature,
  attemptCount: row.attempt_count,
  consecutiveNoopCount: row.consecutive_noop_count,
  holdUntilMs: row.hold_until_ms,
  reviewReason: row.review_reason,
  priority: row.priority,
  lastRunId: row.last_run_id,
  missingSinceMs: row.missing_since_ms,
  discoveredAt: row.discovered_at,
  updatedAt: row.updated_at,
});

const parseState = (raw: string | null): FileState | undefined => {
  if (raw === null) return undefined;
  const match = ALL_STATES.find((state) => state === raw);
  if (match === undefined) {
    throw new ApiError(
      400,
      'invalid-query',
      `"state" must be one of ${ALL_STATES.join(', ')}, got ${JSON.stringify(raw)}. An unknown ` +
        `state would silently match nothing, which reads exactly like an empty library.`,
    );
  }
  return match;
};

const parseMissing = (raw: string | null): boolean | undefined => {
  if (raw === null) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ApiError(
    400,
    'invalid-query',
    `"missing" must be "true" or "false", got ${JSON.stringify(raw)}.`,
  );
};

const requireFile = (ctx: ApiContext, id: string): MediaFileRow => {
  const row = createMediaFileRepo(ctx.db).getById(id);
  if (row === null) {
    throw new ApiError(404, 'file-not-found', `No file with id "${id}".`);
  }
  return row;
};

export const fileRoutes: Route[] = [
  {
    method: 'GET',
    path: '/files',
    handler: ({ query, ctx }) => {
      const { limit, offset } = parsePaging(query);
      const page = createMediaFileRepo(ctx.db).query({
        libraryId: query.get('libraryId') ?? undefined,
        state: parseState(query.get('state')),
        missing: parseMissing(query.get('missing')),
        q: query.get('q') ?? undefined,
        limit,
        offset,
      });
      return {
        total: page.total,
        limit,
        offset,
        items: page.items.map(toFileResource),
      };
    },
  },

  {
    method: 'GET',
    path: '/files/:id',
    handler: ({ params, ctx }) => {
      const row = requireFile(ctx, params.id!);
      const jobRepo = createJobRepo(ctx.db);
      return {
        file: toFileResource(row),
        probe: row.probe_json === null ? null : (JSON.parse(row.probe_json) as unknown),
        preFacts: row.pre_facts_json === null ? null : (JSON.parse(row.pre_facts_json) as unknown),
        postFacts:
          row.post_facts_json === null ? null : (JSON.parse(row.post_facts_json) as unknown),
        // The run history: every attempt this file has been through, newest
        // first. This is what makes "why is this file held?" answerable.
        jobs: jobRepo.listForFile(row.id),
      };
    },
  },

  {
    method: 'POST',
    path: '/files/:id/requeue',
    handler: ({ params, ctx }) => {
      const row = requireFile(ctx, params.id!);
      const repo = createMediaFileRepo(ctx.db);
      repo.requeue(row.id);
      // Requeueing puts work in the queue; a supervisor that only noticed on
      // its next timer tick would leave an idle pool next to a queued file.
      void ctx.supervisor.tick();
      const after = repo.getById(row.id)!;
      return {
        file: toFileResource(after),
        note:
          after.missing_since_ms === null
            ? `Requeued: its attempt count and backoff are cleared, so it is claimable now.`
            : `Requeued, but this file is currently confirmed GONE from disk, so no worker will ` +
              `claim it until a scan finds it again. Nothing is wrong with the queue if it does ` +
              `not run.`,
      };
    },
  },

  {
    method: 'POST',
    path: '/files/:id/priority',
    handler: ({ params, body, ctx }) => {
      const raw = (body as { priority?: unknown } | null)?.priority;
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw new ApiError(
          400,
          'invalid-body',
          `"priority" must be an integer, got ${JSON.stringify(raw)}.`,
        );
      }
      // BOUNDED, because this column is a queue ORDER and an unbounded one is
      // a way to make a file unreachable by accident. `claimNext` orders
      // `priority DESC`, so a fat-fingered `-99999999` sinks a file below
      // every file the daemon will ever discover — indistinguishable, from
      // the outside, from a file the queue has forgotten — and a matching
      // positive number pins one above everything for ever. The range is
      // deliberately small: it is a nudge, not a scheduler.
      if (raw < PRIORITY_MIN || raw > PRIORITY_MAX) {
        throw new ApiError(
          400,
          'invalid-body',
          `"priority" must be between ${String(PRIORITY_MIN)} and ${String(PRIORITY_MAX)}, got ` +
            `${String(raw)}. Priority is a queue nudge, not a scheduler: a number outside this ` +
            `range orders a file below (or above) every file this daemon will ever discover.`,
        );
      }
      const repo = createMediaFileRepo(ctx.db);
      if (!repo.setPriority(params.id!, raw)) {
        throw new ApiError(404, 'file-not-found', `No file with id "${params.id}".`);
      }
      // `claimNext` orders `priority DESC, discovered_at ASC` — this is the
      // only way an operator moves a file ahead of the rest of the queue.
      return { file: toFileResource(repo.getById(params.id!)!) };
    },
  },

  {
    method: 'POST',
    path: '/files/:id/hold',
    handler: ({ params, body, ctx }) => {
      const row = requireFile(ctx, params.id!);
      const hours = optionalNumber(body, 'hours');
      const untilMs = optionalNumber(body, 'untilMs');
      if (hours !== undefined && untilMs !== undefined) {
        throw new ApiError(
          400,
          'invalid-body',
          `Send either "hours" or "untilMs", not both — two different deadlines for one hold.`,
        );
      }
      if (hours === undefined && untilMs === undefined) {
        // A hold with no deadline is not a hold. `claimNext` takes rows in
        // state `held` whose `hold_until_ms` IS NULL — that is how a
        // requeued-but-held file becomes claimable again — so writing
        // `held` with a null deadline would leave the file claimable on the
        // very next tick while reporting that it was held.
        throw new ApiError(
          400,
          'invalid-body',
          `A hold needs a deadline: send "hours" (from now) or "untilMs" (an epoch ` +
            `millisecond). A held file with no deadline is claimed again immediately — the ` +
            `queue treats "held, no deadline" as ready — so it would report as held and run ` +
            `anyway.`,
        );
      }
      const holdUntilMs = untilMs ?? ctx.nowMs() + hours! * 60 * 60 * 1000;

      const repo = createMediaFileRepo(ctx.db);
      repo.setState({ fileId: row.id, state: 'held', holdUntilMs });
      return {
        file: toFileResource(repo.getById(row.id)!),
        note:
          `Held until ${new Date(holdUntilMs).toISOString()}; it becomes claimable again on its ` +
          `own after that, without anyone having to remember to requeue it.`,
      };
    },
  },
  {
    method: 'DELETE',
    path: '/files/:id',
    handler: async ({ params, ctx }) => {
      const row = requireFile(ctx, params.id!);

      // NEVER while a worker holds it. A running job may be inside `Replace
      // Original File`, which empties the original's path and writes the
      // replacement moments later; unlinking underneath that is the same
      // two-writers-one-file shape every claim guard in this codebase exists
      // to prevent, and here it destroys the replacement as well as the
      // original. `requeue` is how an operator gets a running file back.
      if (row.state === 'running') {
        throw new ApiError(
          409,
          'file-running',
          `"${row.path}" is being processed right now. Deleting it under the worker would race ` +
            `the replacement it is writing. Wait for the run to finish, then delete it.`,
        );
      }

      // DISK FIRST, ROW SECOND, and the order is the whole safety argument.
      // If the unlink fails (read-only mount, a share the service user cannot
      // write) the row must survive: forgetting a file that is still on disk
      // does not remove it from the library, it removes its HISTORY — the
      // next scan re-adds it as a brand-new file with no ledger, no attempt
      // count and no record that anyone ever tried to delete it.
      let fileExisted = true;
      try {
        await unlink(row.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Already gone — that is the outcome that was asked for, and a row
          // whose file has vanished is exactly what this deletes next.
          fileExisted = false;
        } else {
          throw new ApiError(
            500,
            'delete-failed',
            `"${row.path}" could not be deleted: ${(error as Error).message}. The file and its ` +
              `history are both untouched.`,
          );
        }
      }

      // Cascades to `job` and, through it, `job_step` — see `MediaFileRepo.delete`.
      createMediaFileRepo(ctx.db).delete(row.id);

      return {
        deleted: true,
        path: row.path,
        fileExisted,
        note: fileExisted
          ? `Deleted "${row.path}" from disk, along with its run history.`
          : `"${row.path}" was already gone from disk; its row and run history are now removed too.`,
      };
    },
  },
];
