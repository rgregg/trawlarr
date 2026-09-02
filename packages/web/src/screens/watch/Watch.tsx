import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import type { LiveState } from '../../api/events.js';
import { formatBytes } from '../files/files-model.js';
import { Link } from '../../shell/Link.js';
import { formatRoute } from '../../shell/route.js';
import { describeFailure } from '../config/library-form-model.js';
import {
  explainIdle,
  JOB_DETAIL_CAP,
  mergeRunningRows,
  ranFfmpeg,
  summarise24h,
  toIdleInputs,
  toLibraryCard,
  type Job24h,
  type JobListRow,
  type LibraryResource,
  type LibraryStats,
  type RestRunningJob,
} from './watch-model.js';

/** `GET /workers`. `baseCounts` is the operator's permanent setting; `target`
 * is what the schedule says RIGHT NOW after applying any active window — the
 * two differ only while a window is overriding the base, which is exactly
 * the signal `explainIdle` needs to tell "nobody configured any workers"
 * apart from "a window has temporarily zeroed them". */
interface WorkerStatus {
  paused: boolean;
  target: Record<string, number>;
  baseCounts: Record<string, number>;
  active: number;
}

/** `GET /system/health`, the one anonymous route. */
interface HealthInfo {
  status: string;
  version: string;
  schemaVersion: number;
}

/** `GET /system/schedule`. */
interface ScheduleInfo {
  timezone: string;
  baseCounts: Record<string, number>;
  windows: Array<{ id: string }>;
}

type Failure = ReturnType<typeof describeFailure>;

/**
 * The failure box every other screen on this branch already renders.
 *
 * Watch used to have its own vocabulary — a raw `error.message` in a bare
 * `<p role="alert">`, with NO retry on any of its four sections — while
 * Diagnose, Files, FileDetail, JobDetail and FlowDetail all rendered
 * `describeFailure` in a `.failure` box with a Retry button. One error state
 * is not a style preference: the retry is the only escape from a failed
 * section, and a screen that shows the daemon's raw message says something
 * different from the one beside it about the same outage.
 */
const FailureBox = (props: { failure: Failure; onRetry: () => void }): JSX.Element => (
  <div role="alert" className="failure">
    <strong>{props.failure.title}</strong>
    <p className="verbatim">{props.failure.message}</p>
    <button type="button" onClick={props.onRetry}>
      Retry
    </button>
  </div>
);

/**
 * The Watch screen: what is running right now, and — the far more common
 * case on a healthy install — why nothing is.
 *
 * Absorbs the old Overview (library convergence, the worker strip) and
 * Activity (the running-jobs list) screens; both are gone from the tree,
 * their model types folded into `watch-model.ts`.
 *
 * FOUR INDEPENDENT SECTIONS, each with its own fetch, its own failure state
 * and its own Retry, in the fixed order Running / Libraries / Last 24 hours
 * / Runtime. A section whose fetch fails says so IN PLACE — it never blanks
 * the other three, which is the regression Task 4 shipped and Task 6 had to
 * avoid repeating. That rule applies WITHIN a section too: Runtime fetches
 * `/workers` as its primary and catches `/system/health` and
 * `/system/schedule` inline, so a failing schedule endpoint can no longer
 * blank the worker counts.
 *
 * Running jobs re-fetch on `live.staleness.jobs`, library stats on
 * `live.staleness.libraries`, the 24h counters on `live.staleness.jobs`, and
 * worker/health/schedule on `live.staleness.workers` — the same per-view
 * counters `Libraries.tsx` already keys its re-fetch off. `live` ITSELF IS
 * IN NO DEPENDENCY ARRAY. It used to be in the libraries effect's, with a
 * comment (inherited from the retired `Overview.tsx`) claiming that
 * "re-derives the cards without re-fetching anything" — which is false:
 * `reduceLive` returns a new object on every `job.progress` AND every
 * `job.log` frame, so during a transcode this screen re-issued `GET
 * /libraries` plus one `GET /libraries/:id/stats` per library several times
 * a second. The fetched resources are held in state and `toLibraryCard` is
 * called at RENDER, which is what actually re-derives the cards from live.
 *
 * Nothing here reads a durable fact off the socket: progress, stage and log
 * are liveness only (`worker/protocol.ts`), so every count, every state and
 * every size comes from REST and stays correct with the socket dead.
 */
export const Watch = (props: {
  client: ApiClient;
  live: LiveState;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, live, navigate } = props;

  // --- Libraries: convergence per library, and the aggregate this screen's
  // idle explanation needs (how many files are queued, whether the install
  // is fully converged). ------------------------------------------------
  const [libraries, setLibraries] = useState<{
    libraries: LibraryResource[];
    stats: LibraryStats[];
  } | null>(null);
  const [libraryFailure, setLibraryFailure] = useState<Failure | null>(null);
  const [libraryAttempt, setLibraryAttempt] = useState(0);
  const staleLibraries = live.staleness.libraries;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resources = await client.get<LibraryResource[]>('/libraries');
        const stats = await Promise.all(
          resources.map(
            async (library) => await client.get<LibraryStats>(`/libraries/${library.id}/stats`),
          ),
        );
        if (cancelled) return;
        setLibraryFailure(null);
        setLibraries({ libraries: resources, stats });
      } catch (error) {
        if (!cancelled) setLibraryFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, staleLibraries, libraryAttempt]);

  const libraryCards =
    libraries === null
      ? null
      : libraries.libraries.map((library, index) =>
          toLibraryCard({ library, stats: libraries.stats[index]!, live }),
        );
  const libraryTotals =
    libraries === null
      ? null
      : libraries.stats.reduce(
          (totals, one) => ({
            total: totals.total + one.total,
            good: totals.good + one.good,
            queued: totals.queued + (one.byState.queued ?? 0),
          }),
          { total: 0, good: 0, queued: 0 },
        );

  // --- Runtime: worker counts, daemon health, the schedule. --------------
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [schedule, setSchedule] = useState<ScheduleInfo | null>(null);
  const [runtimeFailure, setRuntimeFailure] = useState<Failure | null>(null);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const staleWorkers = live.staleness.workers;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // `/workers` is this section's PRIMARY: without it there is nothing
        // to show and no idle explanation to give. The other two are
        // decorations on it, so each is caught inline — sharing one
        // `Promise.all` and one catch meant a failing `/system/schedule`
        // blanked the worker counts, the same regression three earlier
        // tasks fought, one level down.
        const [workers, healthInfo, scheduleInfo] = await Promise.all([
          client.get<WorkerStatus>('/workers'),
          client.get<HealthInfo>('/system/health').then(
            (info) => info,
            () => null,
          ),
          client.get<ScheduleInfo>('/system/schedule').then(
            (info) => info,
            () => null,
          ),
        ]);
        if (cancelled) return;
        setRuntimeFailure(null);
        setWorkerStatus(workers);
        setHealth(healthInfo);
        setSchedule(scheduleInfo);
      } catch (error) {
        if (!cancelled) setRuntimeFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, staleWorkers, runtimeAttempt]);

  // --- Last 24 hours: encoded vs. skipped vs. failed. --------------------
  const [summary, setSummary] = useState<ReturnType<typeof summarise24h> | null>(null);
  const [summaryFailure, setSummaryFailure] = useState<Failure | null>(null);
  const [summaryAttempt, setSummaryAttempt] = useState(0);
  // jobId -> did it run ffmpeg. Kept across refreshes and pruned to the
  // window, so a job's step trace is fetched ONCE however many times this
  // effect re-runs. A ref, not state: writing it must not itself re-render.
  const ffmpegSeen = useRef<Map<string, boolean>>(new Map());
  const staleJobs = live.staleness.jobs;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await client.get<{ items: JobListRow[] }>('/jobs?limit=500');
        const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
        const within = page.items.filter((job) => job.startedAt >= cutoffMs);
        // `GET /jobs` carries no steps — see `packages/server/src/api/routes/jobs.ts`
        // — so whether a job actually ran ffmpeg is one request per job. That
        // used to be EVERY job in the window on EVERY `job.finished` frame:
        // hundreds of requests per completed file on a converging library,
        // accepted by Task 7's review as "bounded" and across a full run not
        // bounded at all. Two things bound it now: answers are remembered
        // (`ffmpegSeen`), and at most `JOB_DETAIL_CAP` NEW ones are fetched
        // per refresh. Whatever is left over is reported as unclassified on
        // screen rather than guessed at.
        const seen = ffmpegSeen.current;
        const pending = within.filter((job) => !seen.has(job.id)).slice(0, JOB_DETAIL_CAP);
        await Promise.all(
          pending.map(async (job) => {
            try {
              const detail = await client.get<{
                steps: Array<{ pluginId: string; logExcerpt: string }>;
              }>(`/jobs/${job.id}`);
              seen.set(job.id, ranFfmpeg(detail.steps));
            } catch {
              // One job's step trace failing to fetch must not blank the
              // whole 24h summary, and must not be counted as a skip either
              // — it stays unclassified and is retried on the next refresh.
            }
          }),
        );
        if (cancelled) return;
        const counted: Job24h[] = within.map((job) => ({
          state: job.state,
          ranFfmpeg: seen.get(job.id) ?? null,
        }));
        // Prune to the window so a long-lived tab does not accumulate an
        // entry for every job the daemon has ever run.
        ffmpegSeen.current = new Map(
          within.flatMap((job) => {
            const known = seen.get(job.id);
            return known === undefined ? [] : [[job.id, known] as const];
          }),
        );
        setSummaryFailure(null);
        setSummary(summarise24h(counted));
      } catch (error) {
        if (!cancelled) setSummaryFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, staleJobs, summaryAttempt]);

  // --- Running: fetched from the record, with live frames laid over it. ---
  const [restRunning, setRestRunning] = useState<RestRunningJob[]>([]);
  const [runningFailure, setRunningFailure] = useState<Failure | null>(null);
  const [runningAttempt, setRunningAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await client.get<{ items: RestRunningJob[] }>('/jobs?state=running&limit=50');
        if (cancelled) return;
        setRunningFailure(null);
        setRestRunning(page.items);
      } catch (error) {
        if (!cancelled) setRunningFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, staleJobs, runningAttempt]);

  // A running row's file is worth one small extra fetch: it carries both the
  // path (a job row has none) and the size. Bounded by how many jobs are
  // actually running, which is the worker count, never the whole library.
  const [runningFiles, setRunningFiles] = useState<
    Record<string, { path: string; sizeBytes: number } | undefined>
  >({});
  const runningRows = mergeRunningRows({ rest: restRunning, files: runningFiles, live });
  const runningFileIds = runningRows.map((row) => row.fileId).join(',');

  useEffect(() => {
    const ids = runningFileIds === '' ? [] : runningFileIds.split(',');
    const unknown = ids.filter((id) => runningFiles[id] === undefined);
    if (unknown.length === 0) return;
    let cancelled = false;
    void (async () => {
      const found = await Promise.all(
        unknown.map(async (id) => {
          try {
            const file = await client.get<{ file: { path: string; sizeBytes: number } }>(
              `/files/${id}`,
            );
            return [id, { path: file.file.path, sizeBytes: file.file.sizeBytes }] as const;
          } catch {
            // A file whose row could not be fetched still renders — without
            // a size, and under the live frame's path if there is one.
            return null;
          }
        }),
      );
      if (cancelled) return;
      setRunningFiles((current) => {
        const next = { ...current };
        for (const entry of found) if (entry !== null) next[entry[0]] = entry[1];
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // `runningFiles` is read but deliberately excluded from the dependency
    // list: it is only consulted to decide which ids are still unknown, and
    // including it would re-run this effect every time it is set by this
    // same effect.
  }, [client, runningFileIds]);

  const idle =
    runningRows.length > 0 || libraryTotals === null || workerStatus === null
      ? null
      : explainIdle(toIdleInputs({ totals: libraryTotals, workers: workerStatus }));

  return (
    <div className="watch">
      <section className="watch-running">
        <h2>Running</h2>
        {runningFailure !== null && (
          <FailureBox
            failure={runningFailure}
            onRetry={() => {
              setRunningAttempt((n) => n + 1);
            }}
          />
        )}
        {runningRows.length === 0 ? (
          idle === null ? (
            runningFailure === null && <p>Loading…</p>
          ) : (
            <div className={`idle-box ${idle.action === null ? 'idle-ok' : 'idle-attention'}`}>
              <h3>{idle.headline}</h3>
              <p>{idle.detail}</p>
              {idle.action !== null && (
                <Link to={idle.action.to} navigate={navigate} className="idle-action">
                  {idle.action.label}
                </Link>
              )}
            </div>
          )
        ) : (
          <ul className="job-list">
            {runningRows.map((row) => (
              <li key={row.jobId} className="job running">
                <div className="watch-running-head">
                  <Link to={`/files/${row.fileId}`} navigate={navigate} className="job-file">
                    {row.name}
                  </Link>
                  <span className="job-progress">
                    {row.percent === null ? row.stage : `${String(row.percent)}% — ${row.stage}`}
                  </span>
                </div>
                {row.percent !== null && (
                  <div
                    className="bar"
                    role="progressbar"
                    aria-valuenow={row.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${row.name} progress`}
                  >
                    <div className="bar-fill" style={{ width: `${String(row.percent)}%` }} />
                  </div>
                )}
                <div className="watch-running-meta">
                  <span className="detail">
                    worker {row.workerId}
                    {runningFiles[row.fileId] !== undefined &&
                      ` — ${formatBytes(runningFiles[row.fileId]!.sizeBytes)}`}
                  </span>
                  <Link to={`/jobs/${row.jobId}`} navigate={navigate} className="watch-job-link">
                    Job detail
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="watch-libraries">
        <h2>Libraries</h2>
        {libraryFailure !== null && (
          <FailureBox
            failure={libraryFailure}
            onRetry={() => {
              setLibraryAttempt((n) => n + 1);
            }}
          />
        )}
        {libraryCards === null ? (
          libraryFailure === null && <p>Loading libraries…</p>
        ) : libraryCards.length === 0 ? (
          // A fresh install must not look like a broken one.
          libraryFailure === null && <p>No libraries yet. Add one to start converging something.</p>
        ) : (
          <ul className="library-cards">
            {libraryCards.map((card) => (
              <li key={card.id} className={`card status-${card.status}`}>
                {/* The card is the ONLY place in this UI that knows a
                    library's id in a context where "show me these files"
                    is the obvious next question — without this link the
                    Files library filter can only be reached by typing a
                    uuid by hand. */}
                <Link
                  to={formatRoute({
                    name: 'files',
                    filters: { library: card.id, state: null, q: null },
                  })}
                  navigate={navigate}
                  className="library-card-link"
                >
                  <h3>{card.name}</h3>
                </Link>
                <p className="headline">{card.headline}</p>
                {/* Status is TEXT as well as a class: colour is never
                          the only carrier of meaning. */}
                <p className="badge">{card.status}</p>
                {card.detail !== null && <p className="detail">{card.detail}</p>}
                <div
                  className="bar"
                  role="progressbar"
                  aria-valuenow={card.convergedPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${card.name} convergence`}
                >
                  <div
                    className="bar-fill"
                    style={{ width: `${String(card.convergedPercent)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="watch-24h">
        <h2>Last 24 hours</h2>
        {summaryFailure !== null && (
          <FailureBox
            failure={summaryFailure}
            onRetry={() => {
              setSummaryAttempt((n) => n + 1);
            }}
          />
        )}
        {summary === null ? (
          summaryFailure === null && <p>Loading…</p>
        ) : (
          <>
            <dl className="watch-stats">
              <div>
                <dt>Encoded</dt>
                <dd>{String(summary.encoded)}</dd>
              </div>
              <div>
                <dt>Skipped</dt>
                <dd>{String(summary.skipped)}</dd>
              </div>
              <div>
                <dt>Failed</dt>
                <dd>{String(summary.failed)}</dd>
              </div>
            </dl>
            {summary.unclassified > 0 && (
              <p className="detail">
                {String(summary.unclassified)} more finished in this window; whether each ran ffmpeg
                is fetched {String(JOB_DETAIL_CAP)} jobs at a time, so the encoded/skipped split
                above is partial and fills in as this refreshes.
              </p>
            )}
          </>
        )}
      </section>

      <section className="watch-runtime">
        <h2>Runtime</h2>
        {runtimeFailure !== null && (
          <FailureBox
            failure={runtimeFailure}
            onRetry={() => {
              setRuntimeAttempt((n) => n + 1);
            }}
          />
        )}
        {workerStatus === null ? (
          runtimeFailure === null && <p>Loading…</p>
        ) : (
          // Three facts about the daemon itself, on one surface. They were
          // three bare paragraphs under a heading while every other section
          // of this screen sat on a card, which made the bottom of the
          // screen read as leftovers rather than as a section.
          <div className="runtime-panel">
            <p className="worker-target">
              {String(workerStatus.active)} running
              {workerStatus.paused ? ', pool paused' : ''} — target{' '}
              {Object.entries(workerStatus.target)
                .map(([workerClass, count]) => `${workerClass} ${String(count)}`)
                .join(', ')}
            </p>
            {health !== null && (
              <p className="detail">
                trawlarr {health.version} (schema {String(health.schemaVersion)}) — {health.status}
              </p>
            )}
            {schedule !== null && (
              <p className="detail">
                Schedule: {schedule.timezone}, {String(schedule.windows.length)} window
                {schedule.windows.length === 1 ? '' : 's'} configured
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
