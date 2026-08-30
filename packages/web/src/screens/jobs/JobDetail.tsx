import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { ApiClientError } from '../../api/client.js';
import { LIVE_LOG_LINES, type LiveState } from '../../api/events.js';
import { Link } from '../../shell/Link.js';
import { describeFailure } from '../config/library-form-model.js';
import { describeFlowVersion, toStepRows, type ApiStep } from './job-detail-model.js';

/**
 * `GET /jobs/:id`'s shape, as the daemon actually returns it — see
 * `packages/server/src/db/job-repo.ts`'s `JobRow` and `JobStepRow`, and
 * `packages/server/src/api/routes/jobs.ts`. `flowId` is shown as a link to
 * the LIVE flow; `flowHash` is resolved below to the exact past VERSION the
 * job walked (frozen at `start()`, so not necessarily what `flowId` points
 * at now — the two links can, and often will, disagree); `nodeId` is
 * fetched and unused on purpose.
 */
interface ApiJobRow {
  id: string;
  fileId: string;
  flowId: string;
  flowHash: string;
  state: string;
  outcome: string | null;
  workerClass: string;
  startedAt: number;
  endedAt: number | null;
  workerPid: number | null;
  workerHost: string | null;
}

interface ApiJobDetail {
  job: ApiJobRow;
  steps: ApiStep[];
}

const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
};

const OUTCOME_LABEL: Record<'ok' | 'failed' | 'running', string> = {
  ok: 'OK',
  failed: 'Failed',
  running: 'Running',
};

/**
 * The job detail screen: the sentence naming exactly why a file was, or was
 * not, rewritten — `Running ffmpeg: ...` and `Skipping ffmpeg: ...` and
 * everything in between, which up to now only a hand-run SQL query against
 * `job_step` could surface. Reasons render whole, in a monospace block, at
 * full width — never truncated and never behind a `<details>`, because the
 * one that flagged ~9.2 TB of pointless rewrites was the FIRST sentence, not
 * a summary of it.
 *
 * LIVE OVERLAYS EXACTLY THREE THINGS while a job runs — percent, stage, and
 * the log tail — nothing else, per the worker protocol's own rule that
 * progress and log are liveness only (`protocol.ts:44`). Steps, outcome and
 * timing always come from the fetch, so a dropped socket makes this screen
 * less lively and never wrong: the step list simply waits for the silent
 * refresh that fires once the live job disappears (see `wasLiveRef` below).
 *
 * Deliberately untested, the same split `FileDetail.tsx` and `Files.tsx`
 * use — `job-detail-model.ts` carries every branch that matters (what
 * counts as "failed", what a plugin id reads as), and this stays a thin
 * renderer over it.
 */
export const JobDetail = (props: {
  client: ApiClient;
  id: string;
  live: LiveState;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, id, live, navigate } = props;

  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<ApiJobDetail | null>(null);
  // Loading is DERIVED, not a state of its own: the only honest moment to
  // show the skeleton is before either a result or a failure exists yet.
  // A separate flag would have to be re-synchronised with `detail` and
  // `failure` by hand at every call site, which is exactly the kind of
  // three-state drift that produced Task 4's "secondary fetch blanks the
  // screen" regression.
  const loading = failure === null && detail === null;

  const [logText, setLogText] = useState<string | null>(null);
  const [logRequested, setLogRequested] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logFailure, setLogFailure] = useState<string | null>(null);

  // The job's `flowHash`, resolved through `GET /flows/versions/by-hash/:hash`.
  // A SECONDARY fetch, same rule as the log and the silent refresh above:
  // its failure must never blank this screen, which already has the job to
  // show. `'resolved'` covers BOTH a real version id and a confirmed
  // `version-not-recorded` (`versionId: null`) — the expected answer for
  // roughly 5,500 job rows that predate migration 007's backfill, and NOT a
  // failure; only any OTHER error lands in `'failed'`.
  const [versionLookup, setVersionLookup] = useState<
    { kind: 'loading' } | { kind: 'resolved'; versionId: string | null } | { kind: 'failed' }
  >({ kind: 'loading' });

  const liveJob = live.jobs[id];
  const isLive = liveJob !== undefined;

  // Navigating from one job to another must not show the previous job's
  // steps while the new one loads — that is a wrong answer wearing the old
  // job's clothes, not a stale one.
  useEffect(() => {
    setDetail(null);
    setFailure(null);
    setLogText(null);
    setLogRequested(false);
    setLogFailure(null);
    setVersionLookup({ kind: 'loading' });
  }, [id]);

  // The PRIMARY load: on mount, on navigating to a new job id, and on an
  // explicit Retry. A real failure here is shown whole — this is the one
  // fetch allowed to replace the screen with an error, because until it
  // succeeds once there is nothing on screen to protect.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<ApiJobDetail>(`/jobs/${id}`);
        if (cancelled) return;
        setDetail(next);
        setFailure(null);
      } catch (error) {
        if (cancelled) return;
        setFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, id, attempt]);

  // A SILENT refresh, fired once on the true→false edge of `isLive` — the
  // moment a running job's socket entry disappears because it finished (see
  // `reduceLive`'s `job.finished` case). This is what replaces the frozen
  // "running" steps and outcome with the real, finished record. A failure
  // here is swallowed rather than shown: the screen already has a good
  // answer from the primary load, and one dropped background request must
  // cost this screen liveness, never correctness or a blanked view — the
  // exact regression Task 4 shipped and then had to fix for its OWN
  // secondary fetch.
  //
  // THIS WATCHES ONE JOB'S OWN EDGE rather than `live.staleness.jobs`, the
  // global counter `Watch.tsx`, `Diagnose.tsx` and `Libraries.tsx` all
  // key their refetches off. Those screens each render a LIST of jobs, so
  // any job finishing is relevant to what they show and the shared counter
  // is the right granularity. This screen renders exactly one job, so the
  // precise signal — did THIS job's live entry just disappear — is what
  // fires the refetch instead of every unrelated job finishing anywhere in
  // the system.
  const wasLiveRef = useRef(isLive);
  useEffect(() => {
    const justFinished = wasLiveRef.current && !isLive;
    wasLiveRef.current = isLive;
    if (!justFinished) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<ApiJobDetail>(`/jobs/${id}`);
        if (!cancelled) setDetail(next);
      } catch {
        // See the comment above: intentionally silent.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, id, isLive]);

  // ANOTHER secondary fetch, deliberately its OWN effect with its OWN
  // try/catch rather than joining the primary load in a `Promise.all` — the
  // exact regression that shipped twice in earlier UI work (a dropped
  // secondary fetch blanking the whole screen) and cost a fix round each
  // time. Keyed on the HASH VALUE, not on `detail` itself, so the silent
  // refresh above (which replaces `detail` with an equivalent object once a
  // live job finishes) does not re-trigger this lookup when the hash it
  // fetched by has not actually changed.
  useEffect(() => {
    const hash = detail?.job.flowHash;
    if (hash === undefined) return;
    let cancelled = false;
    setVersionLookup({ kind: 'loading' });
    void (async () => {
      try {
        const version = await client.get<{ id: string }>(`/flows/versions/by-hash/${hash}`);
        if (!cancelled) setVersionLookup({ kind: 'resolved', versionId: version.id });
      } catch (error) {
        if (cancelled) return;
        // `version-not-recorded` is the expected answer for a job that ran
        // before the backfill, not a failure — it resolves to "no version",
        // same shape as a real hit. Anything else is a real failure.
        if (error instanceof ApiClientError && error.code === 'version-not-recorded') {
          setVersionLookup({ kind: 'resolved', versionId: null });
        } else {
          setVersionLookup({ kind: 'failed' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, detail?.job.flowHash]);

  const onFetchLog = useCallback((): void => {
    setLogRequested(true);
    setLogLoading(true);
    setLogFailure(null);
    void (async () => {
      try {
        const answer = await client.get<{ text: string }>(`/jobs/${id}/log`);
        setLogText(answer.text);
      } catch (error) {
        // A secondary fetch failing must never blank the primary screen —
        // the job's own detail stays exactly as rendered; only this panel
        // shows the problem. 404 "no log file" and 410 "swept after
        // retention" are different absences and both come through here
        // verbatim, never collapsed into one "no log" sentence.
        setLogFailure(describeFailure(error).message);
      } finally {
        setLogLoading(false);
      }
    })();
  }, [client, id]);

  const rows = detail === null ? [] : toStepRows(detail.steps);

  const versionLine =
    detail === null || versionLookup.kind !== 'resolved'
      ? null
      : describeFlowVersion({ hash: detail.job.flowHash, versionId: versionLookup.versionId });

  return (
    <div className="job-page">
      {/* BACK GOES TO THE FILE, not to Diagnose. This link was hardcoded
          "← Diagnose" regardless of how the job was reached, while the
          dominant path is file detail → job history → job; Diagnose is one
          nav click away and the file is not. Until the detail arrives there
          is no file id to point at, so the link waits rather than pointing
          somewhere it might have to change. */}
      {detail !== null && (
        <Link to={`/files/${detail.job.fileId}`} navigate={navigate} className="job-page-back">
          ← File
        </Link>
      )}

      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
          <button
            type="button"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {failure === null && loading && (
        <div className="job-page-skeleton" aria-busy="true" aria-live="polite">
          <p className="help">Loading job…</p>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}

      {failure === null && !loading && detail === null && (
        <div className="job-page-empty">
          <p>No job to show.</p>
        </div>
      )}

      {failure === null && !loading && detail !== null && (
        <>
          <div className={`job-page-header job-page-state-${detail.job.state}`}>
            <h2>Job {detail.job.id}</h2>
            <span className="job-page-state">
              {liveJob !== undefined
                ? liveJob.percent === null
                  ? liveJob.stage
                  : `${String(liveJob.percent)}% — ${liveJob.stage}`
                : detail.job.state}
            </span>
          </div>

          {/* This screen fetches only `GET /jobs/:id` and `GET
              /jobs/:id/log` — the job record carries a file id and no path,
              so the link back is by id rather than a basename a third fetch
              would be needed to know. */}
          <p className="job-page-file">
            File:{' '}
            <Link to={`/files/${detail.job.fileId}`} navigate={navigate}>
              {detail.job.fileId}
            </Link>
          </p>

          <dl className="job-page-meta">
            <div>
              {/* The LIVE flow, by id — "why did this file get rewritten" is
                  usually a question about the graph, and this screen holds
                  the id, so it links rather than hides it. This is the
                  flow's CURRENT binding, which may already differ from the
                  exact definition the job ran under — that is what the
                  "Version" row below is for. */}
              <dt>Flow</dt>
              <dd>
                <Link to={`/flows/${detail.job.flowId}`} navigate={navigate}>
                  {detail.job.flowId}
                </Link>
              </dd>
            </div>
            <div>
              {/* The exact definition the job ran under, frozen at
                  `start()` — resolved from `flowHash` via
                  `describeFlowVersion`. Most job rows on the owner's real
                  install predate migration 007's backfill, so a plain
                  "not recorded" sentence — not a link, not a failure box —
                  is the common case here, and correctly so. */}
              <dt>Version</dt>
              <dd>
                {versionLookup.kind === 'loading' && <span className="help">Checking…</span>}
                {versionLookup.kind === 'failed' && (
                  <span className="help">Could not check which version this job ran under.</span>
                )}
                {versionLine !== null &&
                  (versionLine.to === null ? (
                    <span className="verbatim">{versionLine.text}</span>
                  ) : (
                    <Link to={versionLine.to} navigate={navigate}>
                      {versionLine.text}
                    </Link>
                  ))}
              </dd>
            </div>
            <div>
              <dt>Worker class</dt>
              <dd>{detail.job.workerClass}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{new Date(detail.job.startedAt).toISOString()}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {detail.job.endedAt === null
                  ? 'Still running'
                  : formatDuration(detail.job.endedAt - detail.job.startedAt)}
              </dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd>
                {detail.job.workerHost === null
                  ? '—'
                  : `${detail.job.workerHost}${
                      detail.job.workerPid === null ? '' : ` (pid ${String(detail.job.workerPid)})`
                    }`}
              </dd>
            </div>
          </dl>

          {detail.job.outcome !== null && (
            <p className="job-page-outcome verbatim">{detail.job.outcome}</p>
          )}

          {liveJob !== undefined && liveJob.log.length > 0 && (
            <>
              <h3>Live log</h3>
              <p className="help">
                The last {String(LIVE_LOG_LINES)} lines while the job runs — a tail, not a
                transcript. Fetch the full log below once it has finished.
              </p>
              <pre className="job-log">{liveJob.log.join('\n')}</pre>
            </>
          )}

          <h3>Steps</h3>
          {rows.length === 0 ? (
            <p className="help">No steps recorded yet.</p>
          ) : (
            <ol className="job-steps">
              {rows.map((row) => (
                <li key={row.seq} className={`job-step job-step-${row.outcome}`}>
                  <div className="job-step-head">
                    <span className="job-step-label">{row.label}</span>
                    <span className="job-step-outcome">{OUTCOME_LABEL[row.outcome]}</span>
                    <span className="job-step-duration">{formatDuration(row.durationMs)}</span>
                  </div>
                  {row.reason !== null && <pre className="job-step-reason">{row.reason}</pre>}
                </li>
              ))}
            </ol>
          )}

          <h3>Full log</h3>
          {!logRequested && (
            <button type="button" onClick={onFetchLog}>
              Fetch full log
            </button>
          )}
          {logLoading && <p className="help">Loading log…</p>}
          {logFailure !== null && (
            <div role="alert" className="failure">
              <p className="verbatim">{logFailure}</p>
              <button type="button" onClick={onFetchLog}>
                Retry
              </button>
            </div>
          )}
          {logText !== null && <pre className="job-log">{logText}</pre>}
        </>
      )}
    </div>
  );
};
