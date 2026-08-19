import { createJobRepo } from '../../db/job-repo.js';
import { accepted, ApiError, notImplemented, parsePaging, type Route } from '../router.js';

export const jobRoutes: Route[] = [
  {
    method: 'GET',
    path: '/jobs',
    handler: ({ query, ctx }) => {
      const { limit, offset } = parsePaging(query);
      const page = createJobRepo(ctx.db).query({
        fileId: query.get('fileId') ?? undefined,
        state: query.get('state') ?? undefined,
        limit,
        offset,
      });
      return { total: page.total, limit, offset, items: page.items };
    },
  },

  {
    method: 'GET',
    path: '/jobs/:id',
    handler: ({ params, ctx }) => {
      const repo = createJobRepo(ctx.db);
      const job = repo.getById(params.id!);
      if (job === null) throw new ApiError(404, 'job-not-found', `No job with id "${params.id!}".`);
      // The step trace is the point of a job detail: it is the record of
      // which node made which decision, and it is the only thing that
      // answers "why did this file get this outcome?" after the fact.
      return { job, steps: repo.getSteps(job.id) };
    },
  },

  {
    method: 'GET',
    path: '/jobs/:id/log',
    handler: notImplemented(
      `Per-job log files are not implemented in this build; this endpoint arrives with them. ` +
        `A named 501 rather than a 404 because the route is specified and a client author would ` +
        `otherwise go hunting for a path they got right. Until then, each step's log excerpt is ` +
        `on GET /api/v1/jobs/:id, and live log lines are pushed on the websocket.`,
    ),
  },

  {
    method: 'POST',
    path: '/jobs/:id/cancel',
    handler: ({ params, ctx }) => {
      const jobId = params.id!;
      // Only a job a worker is RUNNING RIGHT NOW can be cancelled, and the
      // supervisor is the only thing that knows which those are. A 404 here
      // rather than a cheerful 202 is the difference between an operator
      // learning the job already finished and an operator waiting for a
      // cancellation that was never possible.
      if (!ctx.supervisor.cancelJob(jobId)) {
        const known = createJobRepo(ctx.db).getById(jobId);
        throw new ApiError(
          404,
          'job-not-running',
          known === null
            ? `No job with id "${jobId}", so there is nothing to cancel.`
            : `Job "${jobId}" is not running on this node right now (its state is ` +
                `"${known.state}"), so there is nothing to cancel. Cancellation stops a live ` +
                `worker; it does not undo a job that has already finished.`,
        );
      }
      // 202: the cancel signal was delivered. The worker's ladder (ask, then
      // SIGTERM the process group, then SIGKILL) takes time, and the row
      // leaves `running` when the job actually ends — watch `job.finished`.
      return accepted({
        cancelling: true,
        jobId,
        note:
          `Cancellation was signalled. The worker is asked to stop, then its whole process ` +
          `group is signalled if it does not — so the file leaves "running" when the job ` +
          `actually ends, not when this call returns. A cancelled job is requeued unpenalised.`,
      });
    },
  },
];
