import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import type { LiveState } from '../../api/events.js';
import { formatBytes } from '../files/files-model.js';
import { Link } from '../../shell/Link.js';
import {
  explainIdle,
  ranFfmpeg,
  summarise24h,
  toLibraryCard,
  toRunningRows,
  type JobListRow,
  type LibraryCard,
  type LibraryResource,
  type LibraryStats,
} from './watch-model.js';

interface WorkerRow {
  id: string;
  workerClass: string;
  hardwareType: string;
  jobId: string | null;
  path: string | null;
  pid: number | undefined;
}

/** `GET /workers`. `baseCounts` is the operator's permanent setting; `target`
 * is what the schedule says RIGHT NOW after applying any active window — the
 * two differ only while a window is overriding the base, which is exactly
 * the signal `explainIdle` needs to tell "nobody configured any workers"
 * apart from "a window has temporarily zeroed them". */
interface WorkerStatus {
  paused: boolean;
  target: Record<string, number>;
  baseCounts: Record<string, number>;
  workers: WorkerRow[];
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

const sumValues = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

/**
 * The Watch screen: what is running right now, and — the far more common
 * case on a healthy install — why nothing is.
 *
 * Absorbs the old Overview (library convergence, the worker strip) and
 * Activity (the running-jobs list) screens; both are gone from the tree,
 * their model types folded into `watch-model.ts`.
 *
 * FOUR INDEPENDENT SECTIONS, each with its own fetch and its own failure
 * state, in the fixed order Running / Libraries / Last 24 hours / Runtime.
 * A section whose fetch fails says so IN PLACE — it never blanks the other
 * three, which is the regression Task 4 shipped and Task 6 had to avoid
 * repeating. Library stats re-fetch on `live.staleness.libraries`, the 24h
 * counters on `live.staleness.jobs`, and worker/health/schedule on
 * `live.staleness.workers` — the same per-view counters `Libraries.tsx`
 * already keys its re-fetch off.
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
  const [libraryCards, setLibraryCards] = useState<LibraryCard[] | null>(null);
  const [libraryTotals, setLibraryTotals] = useState<{
    total: number;
    good: number;
    queued: number;
  } | null>(null);
  const [libraryProblem, setLibraryProblem] = useState<string | null>(null);
  const staleLibraries = live.staleness.libraries;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const libraries = await client.get<LibraryResource[]>('/libraries');
        const stats = await Promise.all(
          libraries.map(
            async (library) => await client.get<LibraryStats>(`/libraries/${library.id}/stats`),
          ),
        );
        if (cancelled) return;
        setLibraryProblem(null);
        setLibraryCards(
          libraries.map((library, index) => toLibraryCard({ library, stats: stats[index]!, live })),
        );
        setLibraryTotals(
          stats.reduce(
            (totals, one) => ({
              total: totals.total + one.total,
              good: totals.good + one.good,
              queued: totals.queued + (one.byState.queued ?? 0),
            }),
            { total: 0, good: 0, queued: 0 },
          ),
        );
      } catch (error) {
        if (!cancelled) setLibraryProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `live` is a dependency too, the same call `Overview.tsx` makes: an
    // in-flight job or a running scan re-derives the cards' status text
    // without a re-fetch.
  }, [client, staleLibraries, live]);

  // --- Runtime: worker counts, daemon health, the schedule. --------------
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [schedule, setSchedule] = useState<ScheduleInfo | null>(null);
  const [runtimeProblem, setRuntimeProblem] = useState<string | null>(null);
  const staleWorkers = live.staleness.workers;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [workers, healthInfo, scheduleInfo] = await Promise.all([
          client.get<WorkerStatus>('/workers'),
          client.get<HealthInfo>('/system/health'),
          client.get<ScheduleInfo>('/system/schedule'),
        ]);
        if (cancelled) return;
        setRuntimeProblem(null);
        setWorkerStatus(workers);
        setHealth(healthInfo);
        setSchedule(scheduleInfo);
      } catch (error) {
        if (!cancelled) setRuntimeProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, staleWorkers]);

  // --- Last 24 hours: encoded vs. skipped vs. failed. --------------------
  const [summary, setSummary] = useState<{
    encoded: number;
    skipped: number;
    failed: number;
  } | null>(null);
  const [summaryProblem, setSummaryProblem] = useState<string | null>(null);
  const staleJobs = live.staleness.jobs;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await client.get<{ items: JobListRow[] }>('/jobs?limit=500');
        const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
        const within = page.items.filter((job) => job.startedAt >= cutoffMs);
        // `GET /jobs` carries no steps — see `packages/server/src/api/routes/jobs.ts`
        // — so whether a job actually ran ffmpeg is fetched per job, but only
        // for the ones inside the window, which is what keeps this bounded
        // even though the page itself is capped at 500.
        const withSteps = await Promise.all(
          within.map(async (job) => {
            try {
              const detail = await client.get<{
                steps: Array<{ pluginId: string; logExcerpt: string }>;
              }>(`/jobs/${job.id}`);
              return { state: job.state, ranFfmpeg: ranFfmpeg(detail.steps) };
            } catch {
              // One job's step trace failing to fetch must not blank the
              // whole 24h summary. It is counted by state alone — a failed
              // job is still counted as failed; anything else falls back to
              // "skipped", the conservative answer when ffmpeg's involvement
              // could not be confirmed.
              return { state: job.state, ranFfmpeg: false };
            }
          }),
        );
        if (cancelled) return;
        setSummaryProblem(null);
        setSummary(summarise24h(withSteps));
      } catch (error) {
        if (!cancelled) setSummaryProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, staleJobs]);

  // --- Running: live only, never fetched. A running row's file size is the
  // one decoration worth a small extra fetch — bounded by how many jobs are
  // actually running, which is the worker count, never the whole library. --
  const runningRows = toRunningRows(live);
  const [fileSizes, setFileSizes] = useState<Record<string, number>>({});
  const runningFileIds = runningRows.map((row) => row.fileId).join(',');

  useEffect(() => {
    const ids = runningFileIds === '' ? [] : runningFileIds.split(',');
    const unknown = ids.filter((id) => fileSizes[id] === undefined);
    if (unknown.length === 0) return;
    let cancelled = false;
    void (async () => {
      const found = await Promise.all(
        unknown.map(async (id) => {
          try {
            const file = await client.get<{ file: { sizeBytes: number } }>(`/files/${id}`);
            return [id, file.file.sizeBytes] as const;
          } catch {
            // Decorative only: a file whose size could not be fetched just
            // renders without one.
            return null;
          }
        }),
      );
      if (cancelled) return;
      setFileSizes((current) => {
        const next = { ...current };
        for (const entry of found) if (entry !== null) next[entry[0]] = entry[1];
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // `fileSizes` is read but deliberately excluded from the dependency
    // list: it is only consulted to decide which ids are still unknown, and
    // including it would re-run this effect every time it is set by this
    // same effect.
  }, [client, runningFileIds]);

  const idle =
    runningRows.length > 0 || libraryTotals === null || workerStatus === null
      ? null
      : explainIdle({
          queued: libraryTotals.queued,
          workers: sumValues(workerStatus.baseCounts),
          converged: libraryTotals.total === 0 || libraryTotals.good === libraryTotals.total,
          withinWindow: sumValues(workerStatus.target) > 0,
        });

  return (
    <div className="watch">
      <section className="watch-running">
        <h2>Running</h2>
        {runningRows.length === 0 ? (
          idle === null ? (
            <p>{libraryProblem ?? runtimeProblem ?? 'Loading…'}</p>
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
                    {fileSizes[row.fileId] !== undefined &&
                      ` — ${formatBytes(fileSizes[row.fileId]!)}`}
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
        {libraryProblem !== null && <p role="alert">{libraryProblem}</p>}
        {libraryCards === null ? (
          libraryProblem === null && <p>Loading libraries…</p>
        ) : libraryCards.length === 0 ? (
          // A fresh install must not look like a broken one.
          libraryProblem === null && <p>No libraries yet. Add one to start converging something.</p>
        ) : (
          <ul className="library-cards">
            {libraryCards.map((card) => (
              <li key={card.id} className={`card status-${card.status}`}>
                <h3>{card.name}</h3>
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
        {summaryProblem !== null && <p role="alert">{summaryProblem}</p>}
        {summary === null ? (
          summaryProblem === null && <p>Loading…</p>
        ) : (
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
        )}
      </section>

      <section className="watch-runtime">
        <h2>Runtime</h2>
        {runtimeProblem !== null && <p role="alert">{runtimeProblem}</p>}
        {workerStatus === null ? (
          runtimeProblem === null && <p>Loading…</p>
        ) : (
          <>
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
          </>
        )}
      </section>
    </div>
  );
};
