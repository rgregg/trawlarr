import type { LiveState } from '../../api/events.js';

/**
 * What is happening, and — far more often on a healthy install — why nothing
 * is.
 *
 * The steady state of this system is "converged, workers 0, nothing
 * running". A screen that renders that identically to a stall or a fetch
 * failure is worse than no screen, so idleness is explained rather than left
 * blank — see `explainIdle` below.
 */
export interface RunningRow {
  jobId: string;
  fileId: string;
  name: string;
  percent: number | null;
  stage: string;
  workerId: string;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const toRunningRows = (live: LiveState): RunningRow[] =>
  Object.values(live.jobs).map((job) => ({
    jobId: job.jobId,
    fileId: job.fileId,
    name: basename(job.path),
    percent: job.percent,
    stage: job.stage,
    workerId: job.workerId,
  }));

export interface IdleReason {
  headline: string;
  detail: string;
  action: { label: string; to: string } | null;
}

/**
 * Why nothing is running, in the order that matches what an operator would
 * actually check.
 *
 * FOUR BRANCHES, EACH REACHABLE: converged (the healthy steady state, and the
 * one this system sits in most of the time — nothing wrong, so no action);
 * workers set to zero (queued work exists but nothing will ever claim it —
 * the daemon's own "worker count 0" install); outside the configured
 * schedule window (queued work exists, workers are allocated, but the clock
 * says not yet); and the transient case where none of the above holds and a
 * worker is simply between polls. Order matters: a library that is both
 * outside its window AND has zero workers is reported as "set workers" first,
 * because raising the count is the fix that matters regardless of the clock.
 */
export const explainIdle = (input: {
  queued: number;
  workers: number;
  converged: boolean;
  withinWindow: boolean;
}): IdleReason => {
  if (input.converged && input.queued === 0) {
    return {
      headline: 'Everything is converged',
      detail: 'No file needs work. Nothing will run until a file changes or a flow does.',
      action: null,
    };
  }
  if (input.workers === 0) {
    return {
      headline: 'Nothing will start',
      detail: `${String(input.queued)} files are queued, but worker count is 0.`,
      action: { label: 'Set workers', to: '/config?tab=workers' },
    };
  }
  if (!input.withinWindow) {
    return {
      headline: 'Outside the schedule window',
      detail: `${String(input.queued)} files are queued and will run when the window opens.`,
      action: { label: 'Change the window', to: '/config?tab=system' },
    };
  }
  return {
    headline: 'Waiting for a worker',
    detail: `${String(input.queued)} files are queued.`,
    action: null,
  };
};

export interface Job24h {
  state: string;
  ranFfmpeg: boolean;
}

/**
 * Encoded vs. skipped is the whole question a "what did the last day do"
 * summary exists to answer — a flow that mostly decides "no rewrite needed"
 * looks identical to an idle one unless the two are told apart. Failed takes
 * priority over both: a failed job's `ranFfmpeg` is whatever step it reached
 * before it stopped, and that partial answer is not the point once it has
 * failed.
 */
export const summarise24h = (
  jobs: Job24h[],
): {
  encoded: number;
  skipped: number;
  failed: number;
} => {
  let encoded = 0;
  let skipped = 0;
  let failed = 0;
  for (const job of jobs) {
    if (job.state === 'failed') failed += 1;
    else if (job.ranFfmpeg) encoded += 1;
    else skipped += 1;
  }
  return { encoded, skipped, failed };
};

export interface StepExcerpt {
  pluginId: string;
  logExcerpt: string;
}

/**
 * Did this job actually run ffmpeg, or did the flow decide the file already
 * matched and skip it?
 *
 * The engine's `trawlarr:execute` step writes one of two sentences and
 * nothing else distinguishes the two outcomes durably — there is no
 * separate boolean column, because the sentence IS the reason (see
 * `job-detail-model.ts`). `logExcerpt` is `TEXT NOT NULL DEFAULT ''`
 * (`001_initial.sql`), never `null`, on the wire — two earlier tasks shipped
 * bugs assuming otherwise, so this reads it as `''` and nothing else. A job
 * with no execute step at all (it failed earlier, or its flow never reaches
 * one) counts as a skip: it did not run ffmpeg, which is the literal truth
 * even though "skipped" undersells "never got there".
 */
export const ranFfmpeg = (steps: StepExcerpt[]): boolean => {
  const execute = steps.find((step) => step.pluginId === 'trawlarr:execute');
  return execute !== undefined && execute.logExcerpt.startsWith('Running ffmpeg');
};
