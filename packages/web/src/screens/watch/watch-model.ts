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

/**
 * One row of `GET /api/v1/jobs`, as the daemon actually reports it.
 *
 * A JOB ROW CARRIES A FILE ID AND NO PATH — the path lives on the file. The
 * "last 24 hours" summary below joins this against the file listing rather
 * than trusting the job page to carry a path itself.
 */
export interface JobListRow {
  id: string;
  fileId: string;
  state: string;
  outcome: string | null;
  startedAt: number;
}

/**
 * A library, exactly as `GET /api/v1/libraries` reports it.
 *
 * Only the fields this screen reads are declared — the resource carries more
 * (roots' extensions, staging and trash directories, user variables) and a
 * structural subset means adding a field to the API never breaks the UI's
 * types. The four pause fields are here because they are the whole point:
 * `pausedReason` is the daemon's machine-readable reason, `pausedBy` says
 * whether a human or the daemon did it, and `pausedExplanation` is
 * `explainPause()`'s sentence naming the consequence.
 */
export interface LibraryResource {
  id: string;
  name: string;
  roots: string[];
  flowId: string | null;
  paused: boolean;
  pausedReason: string | null;
  pausedBy: string | null;
  pausedExplanation: string | null;
}

/** `GET /api/v1/libraries/:id/stats`. */
export interface LibraryStats {
  libraryId: string;
  total: number;
  byState: Record<string, number>;
  good: number;
  missing: number;
  convergedPercent: number;
  paused: boolean;
  pausedExplanation: string | null;
  scanning: boolean;
}

export interface LibraryCard {
  id: string;
  name: string;
  convergedPercent: number;
  total: number;
  counts: Record<string, number>;
  status: 'converged' | 'working' | 'idle' | 'paused' | 'attention';
  headline: string;
  detail: string | null;
}

/**
 * One library, as a card.
 *
 * THE LADDER'S ORDER IS THE DESIGN: a paused library that also has failures
 * is paused first, because the pause is why nothing is happening and the
 * failures are what stopped mattering the moment it paused.
 *
 * `convergedPercent` is the daemon's number, carried through untouched. It is
 * floored there, and 100 is reserved for `good === total` exactly; recomputing
 * it here would let the UI and the CLI disagree about the one number this
 * product exists to report.
 */
export const toLibraryCard = (input: {
  library: LibraryResource;
  stats: LibraryStats;
  live: LiveState;
}): LibraryCard => {
  const { library, stats, live } = input;
  const base = {
    id: library.id,
    name: library.name,
    convergedPercent: stats.convergedPercent,
    total: stats.total,
    counts: stats.byState,
    headline: `${String(stats.convergedPercent)}% converged`,
  };

  if (library.paused) {
    // A LIBRARY THAT SAYS ONLY "paused" IS BARELY BETTER THAN ONE THAT SAYS
    // NOTHING: with no jobs, no errors and no output, a silently-stopped
    // library looks exactly like a finished one. So the reason is the card's
    // detail line — the daemon's own explanation first, the raw reason if
    // there is no explanation, and an explicit admission if there is neither,
    // because "we do not know why" is still information the operator can act
    // on and a blank line is not.
    return {
      ...base,
      status: 'paused',
      detail:
        library.pausedExplanation ?? library.pausedReason ?? 'Paused, with no reason recorded.',
    };
  }

  const seen = live.scanning[library.id];
  if (seen !== undefined) {
    return { ...base, status: 'working', detail: `Scanning — ${String(seen)} files seen` };
  }

  const running = Object.values(live.jobs).find((job) => job.libraryId === library.id);
  if (running !== undefined) {
    return { ...base, status: 'working', detail: `Running ${basename(running.path)}` };
  }

  const failed = stats.byState.failed ?? 0;
  const notConverging = stats.byState.not_converging ?? 0;
  if (failed + notConverging > 0) {
    // Both terminal states need a human: nothing re-queues them, so a
    // library sitting at 98% for ever is only explicable by naming them.
    // Neither word takes a plural "s" — "1 failed", "2 failed".
    const parts = [
      ...(failed > 0 ? [`${String(failed)} failed`] : []),
      ...(notConverging > 0 ? [`${String(notConverging)} not converging`] : []),
    ];
    return { ...base, status: 'attention', detail: parts.join(', ') };
  }

  if (stats.total > 0 && stats.good === stats.total) {
    return { ...base, status: 'converged', detail: null };
  }

  const [largestState, largestCount] = Object.entries(stats.byState)
    .filter(([state]) => state !== 'good')
    .sort((a, b) => b[1] - a[1])[0] ?? ['unknown', 0];
  return {
    ...base,
    status: 'idle',
    detail: largestCount > 0 ? `${String(largestCount)} ${largestState}` : null,
  };
};

export const toRunningRows = (live: LiveState): RunningRow[] =>
  Object.values(live.jobs).map((job) => ({
    jobId: job.jobId,
    fileId: job.fileId,
    name: basename(job.path),
    percent: job.percent,
    stage: job.stage,
    workerId: job.workerId,
  }));

/**
 * One row of `GET /jobs?state=running`, as `job-repo.ts`'s `JobRow` reports
 * it. A job row carries no path and no `workerId` — the path is on the file
 * (fetched separately, the same fetch that already decorated a running row
 * with its size) and the worker is identified durably by pid and host.
 */
export interface RestRunningJob {
  id: string;
  fileId: string;
  workerPid: number | null;
  workerHost: string | null;
}

const restWorkerLabel = (job: RestRunningJob): string => {
  if (job.workerPid === null) return 'unknown';
  return job.workerHost === null
    ? `pid ${String(job.workerPid)}`
    : `${job.workerHost} pid ${String(job.workerPid)}`;
};

/**
 * What is running, from the RECORD, with the socket's frames laid over it.
 *
 * A DEAD SOCKET MUST MAKE THIS SCREEN LESS LIVELY, NEVER WRONG. Running rows
 * used to come from `live.jobs` alone, so a dropped socket rendered the idle
 * box — "Waiting for a worker — N files are queued" — while a transcode was
 * in fact running. That is not stale, it is false, and it is the one thing
 * this screen is not allowed to be.
 *
 * The liveness-only discipline is kept exactly (`worker/protocol.ts`): the
 * durable facts — that a job exists, which file it is on, which worker holds
 * it — all come from `GET /jobs?state=running` and `GET /files/:id`. The
 * socket contributes `percent` and `stage` and nothing else, laid over the
 * fetched row.
 *
 * LIVE-ONLY ROWS ARE STILL SHOWN, appended after the fetched ones. This is
 * not a durable read: `job.started` deliberately bumps no staleness counter
 * (see `api/events.ts`), so a job that started since the last fetch would
 * otherwise be invisible until something else forced a refetch. Showing it
 * costs nothing — the next fetch subsumes it under its own id.
 */
export const mergeRunningRows = (input: {
  rest: RestRunningJob[];
  files: Record<string, { path: string } | undefined>;
  live: LiveState;
}): RunningRow[] => {
  const { rest, files, live } = input;
  const rows: RunningRow[] = rest.map((job) => {
    const liveJob = live.jobs[job.id];
    // The live frame's path is the same path and arrives sooner; the fetched
    // one is what makes the row appear at all with no socket.
    const path = files[job.fileId]?.path ?? liveJob?.path;
    return {
      jobId: job.id,
      fileId: job.fileId,
      name: path === undefined ? 'Loading name…' : basename(path),
      percent: liveJob?.percent ?? null,
      stage: liveJob?.stage ?? 'Running',
      workerId: liveJob?.workerId ?? restWorkerLabel(job),
    };
  });

  const fetched = new Set(rest.map((job) => job.id));
  for (const row of toRunningRows(live)) {
    if (!fetched.has(row.jobId)) rows.push(row);
  }
  return rows;
};

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
 *
 * `workers` IS THE OPERATOR'S PERMANENT SETTING and `withinWindow` says
 * whether the schedule is granting any workers RIGHT NOW — two different
 * numbers (`baseCounts` and `target` on `GET /workers`), and the "worker
 * count is 0" branch is only true when BOTH say zero. It used to fire on
 * `workers === 0` alone, so a base of 0 plus an active window granting
 * workers reported "Nothing will start — worker count is 0" while workers
 * were in fact allocated and about to claim. See `toIdleInputs`, which is
 * where the two numbers get these meanings.
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
  if (input.workers === 0 && !input.withinWindow) {
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

/**
 * The four numbers `explainIdle` reasons over, derived from the two fetches
 * that carry them. Extracted from `Watch.tsx` because this mapping — not the
 * branch ladder — is where `converged` and `withinWindow` GET their meanings,
 * and getting either wrong makes the screen state a confident falsehood
 * about why nothing is running.
 *
 * `withinWindow` is `sum(target) > 0`: `target` is the schedule-EVALUATED
 * count (`routes/workers.ts` applies any active window before answering), so
 * "the schedule is granting workers right now" is exactly what a non-zero
 * target means. `workers` is `sum(baseCounts)`, the permanent setting, which
 * is the only one an operator can raise from the Configure screen the
 * "Set workers" action links to.
 *
 * `converged` treats an EMPTY install as converged: zero files means no file
 * needs work, and "0% converged, nothing queued" would read as a fault on a
 * fresh install that has simply never scanned.
 */
export const toIdleInputs = (input: {
  totals: { total: number; good: number; queued: number };
  workers: { target: Record<string, number>; baseCounts: Record<string, number> };
}): { queued: number; workers: number; converged: boolean; withinWindow: boolean } => {
  const sum = (counts: Record<string, number>): number =>
    Object.values(counts).reduce((total, count) => total + count, 0);
  return {
    queued: input.totals.queued,
    workers: sum(input.workers.baseCounts),
    converged: input.totals.total === 0 || input.totals.good === input.totals.total,
    withinWindow: sum(input.workers.target) > 0,
  };
};

export interface Job24h {
  state: string;
  /**
   * `null` means NOT YET KNOWN, never "did not run ffmpeg". Whether ffmpeg
   * ran is only on `GET /jobs/:id`, one request per job, and that lookup is
   * capped (see `JOB_DETAIL_CAP`) — so a busy day leaves some jobs in the
   * window unclassified, and one that could not be fetched stays unclassified
   * too. Counting either as a skip would quietly under-report encodes, which
   * is the one number this panel exists to give.
   */
  ranFfmpeg: boolean | null;
}

/**
 * How many `GET /jobs/:id` lookups one refresh of the 24h summary may make.
 *
 * The panel used to fetch the step trace for EVERY job in the window and
 * re-run the whole thing on every `job.finished` frame — hundreds of
 * requests per completed file on a converging library. `Watch.tsx` now
 * remembers each answer for as long as the job stays in the window and
 * fetches at most this many NEW ones per refresh, so the steady state is one
 * lookup per completion; anything past the cap is reported as unclassified
 * rather than guessed at.
 */
export const JOB_DETAIL_CAP = 25;

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
  unclassified: number;
} => {
  let encoded = 0;
  let skipped = 0;
  let failed = 0;
  let unclassified = 0;
  for (const job of jobs) {
    if (job.state === 'failed') failed += 1;
    else if (job.ranFfmpeg === null) unclassified += 1;
    else if (job.ranFfmpeg) encoded += 1;
    else skipped += 1;
  }
  return { encoded, skipped, failed, unclassified };
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
