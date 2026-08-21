import type { LiveState } from '../api/events.js';

export interface JobRow {
  jobId: string;
  path: string;
  live: boolean;
  percent: number | null;
  stage: string;
  outcome: string | null;
  state: string | null;
  startedAtMs: number;
  workerId: string | null;
  pid: number | null;
}

export interface RecentJob {
  id: string;
  file_path?: string;
  path?: string;
  state: string;
  outcome: string | null;
  started_at: number;
}

/**
 * One row of `GET /api/v1/jobs`, as the daemon actually reports it.
 *
 * A JOB ROW CARRIES A FILE ID AND NO PATH — the path lives on the file, and
 * a job outlives the row it names. That is why `toRecentJobs` takes a
 * separately-fetched path map instead of trusting the job listing to carry
 * one: the alternative is a history list of opaque uuids.
 */
export interface JobListRow {
  id: string;
  fileId: string;
  state: string;
  outcome: string | null;
  startedAt: number;
}

/**
 * The job listing, adapted to what `mergeJobs` reads.
 *
 * A path that could not be resolved is LEFT OUT rather than faked. A file
 * deleted from the library takes its path with it, and inventing one would
 * put a path on a row for a file that is not there.
 */
export const toRecentJobs = (input: {
  items: JobListRow[];
  pathByFileId: Record<string, string>;
}): RecentJob[] =>
  input.items.map((job) => {
    const path = input.pathByFileId[job.fileId];
    return {
      id: job.id,
      ...(path === undefined ? {} : { path }),
      state: job.state,
      outcome: job.outcome,
      started_at: job.startedAt,
    };
  });

/**
 * The list Activity renders: what is running now, then what ran recently.
 *
 * A LIVE FRAME BEATS A FETCHED ROW for the same job id, always. The REST page
 * is a snapshot taken when it was requested; the socket is current. A row
 * showing "queued" beside a progress bar at 42% is the shape that makes a UI
 * look broken when nothing is wrong.
 */
export const mergeJobs = (input: { live: LiveState; recent: RecentJob[] }): JobRow[] => {
  const liveRows: JobRow[] = Object.values(input.live.jobs).map((job) => ({
    jobId: job.jobId,
    path: job.path,
    live: true,
    percent: job.percent,
    stage: job.stage,
    outcome: null,
    state: null,
    startedAtMs:
      input.recent.find((candidate) => candidate.id === job.jobId)?.started_at ??
      Number.MAX_SAFE_INTEGER,
    workerId: job.workerId,
    pid: job.pid,
  }));

  const liveIds = new Set(liveRows.map((row) => row.jobId));
  const finishedRows: JobRow[] = input.recent
    .filter((job) => !liveIds.has(job.id))
    .map((job) => ({
      jobId: job.id,
      path: job.path ?? job.file_path ?? '',
      live: false,
      percent: null,
      stage: '',
      outcome: job.outcome,
      state: job.state,
      startedAtMs: job.started_at,
      workerId: null,
      pid: null,
    }));

  const byNewest = (a: JobRow, b: JobRow): number => b.startedAtMs - a.startedAtMs;
  return [...liveRows.sort(byNewest), ...finishedRows.sort(byNewest)];
};

/**
 * ffmpeg cannot always report a percentage. "0%" would be a lie and an empty
 * string looks like a hang, so an unknown percentage shows the stage alone.
 */
export const formatProgress = (job: JobRow): string => {
  if (job.live) {
    return job.percent === null ? job.stage : `${String(job.percent)}% — ${job.stage}`;
  }
  const state = job.state ?? 'finished';
  return job.outcome === null ? state : `${state} — ${job.outcome}`;
};
