import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { LIVE_LOG_LINES, type LiveJob, type LiveState } from '../api/events.js';
import { describeFailure } from './library-form-model.js';
import {
  formatProgress,
  mergeJobs,
  toRecentJobs,
  type JobListRow,
  type JobRow,
} from './activity-model.js';

interface JobStep {
  seq: number;
  nodeId: string;
  pluginId: string;
  outputNumber: number | null;
  durationMs: number;
  logExcerpt: string;
}

interface JobDetail {
  job: { id: string; state: string; outcome: string | null; startedAt: number };
  steps: JobStep[];
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The step timeline, from whichever source is current for this job. */
const Steps = (props: { live: LiveJob | undefined; detail: JobDetail | null }): JSX.Element => {
  const rows =
    props.live !== undefined
      ? props.live.steps.map((step) => ({
          seq: step.seq,
          pluginId: step.pluginId,
          outputNumber: step.outputNumber,
          durationMs: step.durationMs,
        }))
      : (props.detail?.steps ?? []);

  if (rows.length === 0) {
    return <p className="help">No steps recorded yet.</p>;
  }
  return (
    <ol className="steps">
      {rows.map((step) => (
        <li key={step.seq}>
          <span className="step-plugin">{step.pluginId}</span>{' '}
          <span className="help">
            {/* The output number IS the decision that node made — which
                branch the flow took — and it is the only thing that answers
                "why did this file get this outcome?" afterwards. */}
            output {step.outputNumber === null ? 'none' : String(step.outputNumber)},{' '}
            {String(step.durationMs)} ms
          </span>
        </li>
      ))}
    </ol>
  );
};

/**
 * One job, opened.
 *
 * The two sources are exclusive and the LIVE one wins while it exists: a
 * running job's steps and log arrive on the socket, and the same job's
 * durable record is fetched once it has finished. Nothing here polls.
 */
const Detail = (props: { client: ApiClient; row: JobRow; live: LiveState }): JSX.Element => {
  const liveJob = props.live.jobs[props.row.jobId];
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [logProblem, setLogProblem] = useState<string | null>(null);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const [cancelFailure, setCancelFailure] = useState<ReturnType<typeof describeFailure> | null>(
    null,
  );
  const [cancelling, setCancelling] = useState(false);
  const { client } = props;
  const jobId = props.row.jobId;
  const isLive = liveJob !== undefined;

  useEffect(() => {
    // A LIVE JOB IS NOT FETCHED. Its steps and its log tail are already on
    // screen from the socket, and a fetch would race them with a snapshot
    // that is older than what is being rendered.
    if (isLive) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<JobDetail>(`/jobs/${jobId}`);
        if (!cancelled) setDetail(next);
      } catch (error) {
        if (!cancelled) setDetail(null);
        if (!cancelled) setLogProblem(describeFailure(error).message);
      }
      try {
        const answer = await client.get<{ text: string }>(`/jobs/${jobId}/log`);
        if (cancelled) return;
        setLog(answer.text);
        setLogProblem(null);
      } catch (error) {
        // 404 "this job has no log file" and 410 "kept for N days, and this
        // one is past it" are DIFFERENT absences and the daemon writes both
        // out in full. Rendered verbatim, because "no log" would collapse
        // them into one and lose the part that says where to look instead.
        if (!cancelled) setLogProblem(describeFailure(error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, jobId, isLive]);

  const cancel = async (): Promise<void> => {
    setCancelling(true);
    setCancelFailure(null);
    setCancelNote(null);
    try {
      const answer = await client.post<{ note: string }>(`/jobs/${jobId}/cancel`, {});
      setCancelNote(answer.note);
    } catch (error) {
      // The daemon's 404 is the interesting case: the job already finished,
      // and its message says cancellation stops a live worker rather than
      // undoing a finished job. That distinction is the whole answer.
      setCancelFailure(describeFailure(error));
    } finally {
      setCancelling(false);
    }
  };

  const lines = liveJob?.log ?? (log === null ? [] : log.split('\n'));

  return (
    <section className="job-detail">
      <h3>{basename(props.row.path)}</h3>
      <p className="help verbatim">{props.row.path}</p>
      <p>
        {formatProgress(props.row)}
        {props.row.workerId !== null && ` — worker ${props.row.workerId}`}
        {props.row.pid !== null && ` (pid ${String(props.row.pid)})`}
      </p>

      {isLive && (
        <>
          <div className="row-actions">
            <button type="button" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? 'Cancelling…' : 'Cancel this job'}
            </button>
          </div>
          <p className="help">
            Cancelling is a hard stop: the worker is asked to stop, then its whole process group is
            signalled. It is not the same as a schedule window closing, which lets the job it is
            running finish. A cancelled job is requeued unpenalised.
          </p>
        </>
      )}
      {cancelNote !== null && <p className="detail verbatim">{cancelNote}</p>}
      {cancelFailure !== null && (
        <div role="alert" className="failure">
          <strong>{cancelFailure.title}</strong>
          <p className="verbatim">{cancelFailure.message}</p>
        </div>
      )}

      <h4>Steps</h4>
      <Steps live={liveJob} detail={detail} />

      <h4>Log</h4>
      {logProblem !== null && (
        <div role="alert" className="failure">
          <p className="verbatim">{logProblem}</p>
        </div>
      )}
      {lines.length === 0 ? (
        <p className="help">Nothing logged yet.</p>
      ) : (
        <>
          {isLive && (
            <p className="help">
              The last {String(LIVE_LOG_LINES)} lines while the job runs — a tail, not a transcript.
              The whole log is on disk and is what this panel shows once the job has finished.
            </p>
          )}
          <pre className="job-log">{lines.join('\n')}</pre>
        </>
      )}
    </section>
  );
};

/**
 * The Activity screen: what is running now, and what ran recently.
 *
 * LIVE AND RE-FETCHED, in that order of authority. Percentage, stage, step
 * trace and log tail come from the socket and exist only while a job runs;
 * the history, every finished job's state and outcome, and the whole log come
 * from REST. Nothing durable is ever read from a frame — `job.finished`'s
 * state is thrown away by the reducer on purpose — so a reload mid-job, or a
 * socket that drops, costs liveness and never correctness: the row comes back
 * from `GET /jobs` and starts moving again at the next frame. No replay is
 * asked for and none is owed.
 */
export const Activity = (props: { client: ApiClient; live: LiveState }): JSX.Element => {
  const [recent, setRecent] = useState<JobRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Paths are cached across re-fetches: a job listing carries a file id, and
  // resolving one costs a request. A file's path does not change under a job
  // that has already finished, so it is resolved once.
  const paths = useRef<Record<string, string>>({});
  const { client } = props;
  const stale = props.live.staleness.jobs;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await client.get<{ items: JobListRow[] }>('/jobs?limit=25');
        const unknown = [...new Set(page.items.map((job) => job.fileId))].filter(
          (fileId) => paths.current[fileId] === undefined,
        );
        await Promise.all(
          unknown.map(async (fileId) => {
            try {
              const file = await client.get<{ file: { path: string } }>(`/files/${fileId}`);
              paths.current[fileId] = file.file.path;
            } catch {
              // A file deleted from the library takes its path with it. The
              // job still belongs in the history; it renders without one.
            }
          }),
        );
        if (cancelled) return;
        setProblem(null);
        setRecent(
          mergeJobs({
            live: props.live,
            recent: toRecentJobs({ items: page.items, pathByFileId: paths.current }),
          }),
        );
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetched when a job finished (the counter), and re-merged whenever a
    // frame moved a running job — never on a timer.
  }, [client, stale, props.live]);

  if (problem !== null) return <p role="alert">{problem}</p>;
  if (recent === null) return <p>Loading jobs…</p>;

  const rows = recent;
  const selectedRow = rows.find((row) => row.jobId === selected) ?? null;
  const running = rows.filter((row) => row.live);
  const finished = rows.filter((row) => !row.live);

  const list = (group: JobRow[]): JSX.Element => (
    <ul className="job-list">
      {group.map((row) => (
        <li key={row.jobId} className={row.live ? 'job running' : 'job finished'}>
          <button
            type="button"
            aria-current={row.jobId === selected ? 'true' : undefined}
            onClick={() => {
              setSelected(row.jobId === selected ? null : row.jobId);
            }}
          >
            <span className="job-file">{row.path === '' ? row.jobId : basename(row.path)}</span>{' '}
            {/* Progress is TEXT as well as a bar: a bar alone carries its
                meaning only in colour and width. */}
            <span className="job-progress">{formatProgress(row)}</span>
          </button>
          {row.live && row.percent !== null && (
            <div
              className="bar"
              role="progressbar"
              aria-valuenow={row.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${basename(row.path)} progress`}
            >
              <div className="bar-fill" style={{ width: `${String(row.percent)}%` }} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="activity">
      <section>
        <h2>Running</h2>
        {running.length === 0 ? (
          <p>
            Nothing is running. A converged library is quiet on purpose — this is what finished
            looks like.
          </p>
        ) : (
          list(running)
        )}

        <h2>Recently finished</h2>
        {finished.length === 0 ? <p>No jobs have finished yet.</p> : list(finished)}
      </section>
      {selectedRow !== null && <Detail client={client} row={selectedRow} live={props.live} />}
    </div>
  );
};
