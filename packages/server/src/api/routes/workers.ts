import { WORKER_CLASSES, type WorkerClass } from '@trawlarr/core';
import { SettingValidationError } from '../../db/settings-repo.js';
import { ApiError, type ApiContext, type Route } from '../router.js';

const statusResource = (ctx: ApiContext) => {
  const status = ctx.supervisor.status();
  return {
    paused: status.paused,
    /** What the schedule says this instant — the pool size the daemon is aiming at. */
    target: status.target,
    baseCounts: ctx.settings.getSchedule().baseCounts,
    workers: status.workers,
    active: status.workers.length,
  };
};

export const workerRoutes: Route[] = [
  {
    method: 'GET',
    path: '/workers',
    handler: ({ ctx }) => statusResource(ctx),
  },

  {
    method: 'PUT',
    path: '/workers/counts',
    handler: async ({ body, ctx }) => {
      if (body === null || typeof body !== 'object') {
        throw new ApiError(
          400,
          'invalid-body',
          `Send an object of worker-class counts, e.g. {"transcode": 2}. Valid classes: ` +
            `${WORKER_CLASSES.join(', ')}.`,
        );
      }
      const patch = body as Record<string, unknown>;
      for (const key of Object.keys(patch)) {
        if (!(WORKER_CLASSES as readonly string[]).includes(key)) {
          throw new ApiError(
            400,
            'invalid-body',
            `"${key}" is not a worker class. Valid classes: ${WORKER_CLASSES.join(', ')}.`,
          );
        }
      }

      const schedule = ctx.settings.getSchedule();
      const baseCounts = { ...schedule.baseCounts } as Record<WorkerClass, number>;
      for (const workerClass of WORKER_CLASSES) {
        const value = patch[workerClass];
        if (value !== undefined) baseCounts[workerClass] = value as number;
      }

      // THE SCHEDULE IS THE SINGLE SOURCE OF TRUTH for how many workers run.
      // There is deliberately no separate "current counts" concept to drift
      // out of step with it: a base count written here is what
      // `evaluateSchedule` reads on the very next tick, and any active
      // window still overrides it for the classes that window names.
      try {
        ctx.settings.setSchedule({ ...schedule, baseCounts });
      } catch (error) {
        if (error instanceof SettingValidationError) {
          throw new ApiError(400, 'invalid-body', error.message);
        }
        throw error;
      }

      // Immediately, not at the next timer tick: a worker-count change that
      // takes a poll interval to appear is what makes a UI's worker strip
      // look broken.
      await ctx.supervisor.tick();
      return statusResource(ctx);
    },
  },

  {
    method: 'POST',
    path: '/workers/pause',
    handler: ({ ctx }) => {
      // Running jobs are NOT cancelled: a two-hour transcode killed at 90%
      // produces nothing and costs the whole two hours again later. Pause
      // stops new work from starting; POST /jobs/:id/cancel is the hard stop.
      ctx.supervisor.pause();
      return {
        ...statusResource(ctx),
        note:
          `Paused: nothing new will be claimed. Jobs already running are left to finish — ` +
          `killing a transcode part-way produces nothing and costs its whole runtime again. ` +
          `Use POST /api/v1/jobs/:id/cancel to stop one now.`,
      };
    },
  },

  {
    method: 'POST',
    path: '/workers/resume',
    handler: async ({ ctx }) => {
      ctx.supervisor.resume();
      await ctx.supervisor.tick();
      return statusResource(ctx);
    },
  },
];
