/**
 * The live channel's frame types and the fold that turns them into view state.
 *
 * The union below is a HAND-WRITTEN COPY of the one in
 * `packages/server/src/daemon/events.ts`. `@trawlarr/server` is a Node
 * package — better-sqlite3, node:fs, node:child_process — and importing it
 * for a type would drag its whole module graph into the browser bundle's
 * type graph. The copy is kept honest by the end-to-end check that drives a
 * real daemon's socket through this reducer, not by trust.
 *
 * `FileState` and `WorkerClass` are duplicated for the same reason, and
 * `scan.finished`'s `summary` is `unknown` rather than the server's
 * `ScanSummary`: nothing here reads it, because the summary is durable and
 * therefore re-fetched.
 */
export type FileState =
  'unknown' | 'queued' | 'running' | 'good' | 'failed' | 'not_converging' | 'held';

export type WorkerClass = 'transcode' | 'health';

export type TrawlarrEvent =
  | {
      type: 'job.started';
      jobId: string;
      fileId: string;
      libraryId: string;
      path: string;
      workerId: string;
      /** The forked worker's own pid; null only when nothing was forked. */
      pid: number | null;
    }
  | { type: 'job.progress'; jobId: string; percent: number | null; stage: string }
  | {
      type: 'job.step';
      jobId: string;
      seq: number;
      pluginId: string;
      outputNumber: number | null;
      durationMs: number;
    }
  | { type: 'job.log'; jobId: string; text: string }
  | { type: 'job.finished'; jobId: string; fileId: string; state: FileState; outcome: string }
  | { type: 'scan.progress'; libraryId: string; seen: number }
  | { type: 'scan.finished'; libraryId: string; summary: unknown }
  | { type: 'library.paused'; libraryId: string; reason: string }
  | { type: 'library.resumed'; libraryId: string }
  | { type: 'workers.changed'; target: Record<WorkerClass, number>; active: number };

/**
 * How many log lines a running job keeps in memory.
 *
 * A tail, not a transcript: ffmpeg emits a line every fraction of a second
 * and a tab left open overnight would otherwise grow without bound. The full
 * log is durable and fetched from `GET /jobs/:id/log`.
 */
export const LIVE_LOG_LINES = 200;

export interface LiveJob {
  jobId: string;
  fileId: string;
  libraryId: string;
  path: string;
  workerId: string;
  pid: number | null;
  percent: number | null;
  stage: string;
  steps: Array<{ seq: number; pluginId: string; outputNumber: number | null; durationMs: number }>;
  log: string[];
}

export interface LiveState {
  jobs: Record<string, LiveJob>;
  /** libraryId -> files seen so far by the scan currently walking it. */
  scanning: Record<string, number>;
  /**
   * Monotonic counters, one per durable view. Every increment means "what you
   * fetched is out of date"; nothing here is ever the answer itself.
   */
  staleness: { libraries: number; jobs: number; workers: number };
}

export const initialLiveState: LiveState = {
  jobs: {},
  scanning: {},
  staleness: { libraries: 0, jobs: 0, workers: 0 },
};

const bump = (state: LiveState, ...views: Array<keyof LiveState['staleness']>): LiveState => {
  const staleness = { ...state.staleness };
  for (const view of views) staleness[view] += 1;
  return { ...state, staleness };
};

/**
 * Fold one live frame into view state.
 *
 * THE REDUCER IS NEVER THE RECORD. Durable facts — a file's state, a
 * library's convergence, a job's outcome — are re-fetched over REST; this
 * holds only what changes faster than a fetch can follow (in-flight progress,
 * a log tail, a scan's running count) plus counters saying which fetch is now
 * out of date. That is what makes a dropped socket cost liveness and never
 * correctness, and a reconnecting client owed no replay: it starts from
 * `initialLiveState`, every staleness counter resets to zero, and the screens
 * re-fetch because their inputs changed. Nothing is missing that a fetch
 * cannot supply.
 *
 * Note what is deliberately absent: `job.finished` carries the file's new
 * state and this reducer THROWS IT AWAY, keeping only "re-fetch jobs and
 * libraries". A client that missed the frame is then stale, never wrong —
 * whereas a reducer that recorded the state would show a file as good long
 * after a later frame it dropped had moved it on.
 */
export const reduceLive = (state: LiveState, event: TrawlarrEvent): LiveState => {
  switch (event.type) {
    // A STARTING JOB IS NOT A STALE VIEW. The running job is fully described
    // by the row this adds to `jobs`, so there is nothing a re-fetch would
    // tell a screen that it does not already have. Only the FINISH moves a
    // durable record — the job leaves the running set and joins history, and
    // the file it touched has a new state — which is why `job.finished`
    // bumps and this does not.
    case 'job.started':
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [event.jobId]: {
            jobId: event.jobId,
            fileId: event.fileId,
            libraryId: event.libraryId,
            path: event.path,
            workerId: event.workerId,
            pid: event.pid,
            percent: null,
            stage: 'starting',
            steps: [],
            log: [],
          },
        },
      };

    case 'job.progress': {
      const job = state.jobs[event.jobId];
      // Connecting mid-job is normal and no replay is owed, so a frame for a
      // job whose `job.started` we never saw is dropped rather than turned
      // into a row with no path and no library.
      if (job === undefined) return state;
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [event.jobId]: { ...job, percent: event.percent, stage: event.stage },
        },
      };
    }

    case 'job.step': {
      const job = state.jobs[event.jobId];
      if (job === undefined) return state;
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [event.jobId]: {
            ...job,
            steps: [
              ...job.steps,
              {
                seq: event.seq,
                pluginId: event.pluginId,
                outputNumber: event.outputNumber,
                durationMs: event.durationMs,
              },
            ],
          },
        },
      };
    }

    case 'job.log': {
      const job = state.jobs[event.jobId];
      if (job === undefined) return state;
      const log = [...job.log, event.text];
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [event.jobId]: { ...job, log: log.slice(-LIVE_LOG_LINES) },
        },
      };
    }

    case 'job.finished': {
      const jobs = { ...state.jobs };
      delete jobs[event.jobId];
      return bump({ ...state, jobs }, 'jobs', 'libraries');
    }

    case 'scan.progress':
      return { ...state, scanning: { ...state.scanning, [event.libraryId]: event.seen } };

    case 'scan.finished': {
      const scanning = { ...state.scanning };
      delete scanning[event.libraryId];
      return bump({ ...state, scanning }, 'libraries');
    }

    case 'library.paused':
    case 'library.resumed':
      return bump(state, 'libraries');

    case 'workers.changed':
      return bump(state, 'workers');
  }
};
