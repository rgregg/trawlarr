import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { describeFailure } from '../library-form-model.js';
import { explainState, toStreamRows } from './file-detail-model.js';
import { formatBytes, type ApiFile } from './files-model.js';

/**
 * `GET /files/:id` returns every column the listing leaves out, plus the
 * raw probe and the run history — this is the shape a listing row cannot
 * carry, extended from `ApiFile` rather than redefined beside it so the two
 * never drift on the fields they share.
 */
interface ApiFileDetail extends ApiFile {
  signature: string | null;
  attemptCount: number;
  holdUntilMs: number | null;
  mtimeMs: number;
  priority: number;
}

interface ApiJob {
  id: string;
  fileId: string;
  flowId: string;
  flowHash: string;
  state: string;
  outcome: string | null;
  startedAt: number;
  endedAt: number | null;
}

interface DryRunExecuteDecision {
  nodeId: string;
  skip: boolean;
  reason: string;
}

interface DryRunResult {
  complete: boolean;
  stoppedBecause: string | null;
  wouldRunFfmpeg: boolean;
  executeDecisions: DryRunExecuteDecision[];
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The priority a click on "Raise priority" sets — ahead of anything the queue assigns on its own. */
const RAISED_PRIORITY = 10;

/**
 * The file detail screen: the answer to "why is this file in this state",
 * which a week of running a real 4,625-file library answered with ffprobe
 * and ad-hoc SQL every single time because nothing in the product would say
 * it. `explainState` is the point; the streams and the job history are the
 * evidence for it.
 *
 * Deliberately untested — `file-detail-model.ts` carries every branch that
 * matters, and this stays a thin renderer over it, the same split
 * `Files.tsx` uses over `files-model.ts`.
 */
export const FileDetail = (props: {
  client: ApiClient;
  id: string;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, id, navigate } = props;

  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [file, setFile] = useState<ApiFileDetail | null>(null);
  const [probe, setProbe] = useState<unknown>(null);
  const [jobs, setJobs] = useState<ApiJob[]>([]);

  const [requeueBusy, setRequeueBusy] = useState(false);
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    setActionError(null);
    setDryRun(null);

    void (async () => {
      try {
        const [detail, jobPage] = await Promise.all([
          client.get<{ file: ApiFileDetail; probe: unknown }>(`/files/${id}`),
          client.get<{ items: ApiJob[] }>(`/jobs?fileId=${id}&limit=20`),
        ]);
        if (cancelled) return;
        setFile(detail.file);
        setProbe(detail.probe);
        setJobs(jobPage.items);
        setLoading(false);
      } catch (error) {
        if (cancelled) return;
        setFailure(describeFailure(error));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, id, attempt]);

  const runAction = useCallback(
    async (
      setBusy: (busy: boolean) => void,
      call: () => Promise<{ file: ApiFileDetail }>,
    ): Promise<void> => {
      setBusy(true);
      setActionError(null);
      try {
        const result = await call();
        setFile(result.file);
      } catch (error) {
        setActionError(describeFailure(error).message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const onRequeue = useCallback((): void => {
    void runAction(setRequeueBusy, async () => await client.post(`/files/${id}/requeue`));
  }, [client, id, runAction]);

  const onRaisePriority = useCallback((): void => {
    void runAction(
      setPriorityBusy,
      async () => await client.post(`/files/${id}/priority`, { priority: RAISED_PRIORITY }),
    );
  }, [client, id, runAction]);

  // The flow to replay is the one the file's own history ran under — a file
  // with no jobs yet has never run through any flow, so there is nothing to
  // dry-run against and the button stays disabled rather than guessing.
  const flowId = jobs[0]?.flowId ?? null;

  const onDryRun = useCallback((): void => {
    if (flowId === null) return;
    setDryRunBusy(true);
    setActionError(null);
    setDryRun(null);
    void (async () => {
      try {
        const result = await client.post<DryRunResult>(`/flows/${flowId}/dry-run`, { fileId: id });
        setDryRun(result);
      } catch (error) {
        setActionError(describeFailure(error).message);
      } finally {
        setDryRunBusy(false);
      }
    })();
  }, [client, flowId, id]);

  const explanation =
    file === null
      ? null
      : explainState({
          state: file.state,
          signature: file.signature,
          // Best-effort: the file's own row does not carry a flow hash, and
          // `explainState` does not branch on this value today — the flow a
          // file most recently ran under is close enough to be informative
          // without a third fetch just to look up the library's current one.
          flowHash: jobs[0]?.flowHash ?? null,
          attemptCount: file.attemptCount,
          lastJobReason: jobs[0]?.outcome ?? null,
          holdUntilMs: file.holdUntilMs,
          nowMs: Date.now(),
        });

  const streams = toStreamRows(probe);

  return (
    <div className="file-detail">
      <Link to="/files" navigate={navigate} className="file-detail-back">
        ← Files
      </Link>

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
        <div className="file-detail-skeleton" aria-busy="true" aria-live="polite">
          <p className="help">Loading file…</p>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}

      {failure === null && !loading && file === null && (
        <div className="file-detail-empty">
          <p>No file to show.</p>
        </div>
      )}

      {failure === null && !loading && file !== null && (
        <>
          <div className={`file-detail-header file-row-state-${file.state}`}>
            <h2 title={file.path}>{basename(file.path)}</h2>
            <span className="file-detail-state">{file.state}</span>
          </div>
          <p className="file-detail-path">{file.path}</p>

          {explanation !== null && <p className="file-detail-explain">{explanation}</p>}

          <dl className="file-detail-meta">
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(file.sizeBytes)}</dd>
            </div>
            <div>
              <dt>Modified</dt>
              <dd>{new Date(file.mtimeMs).toISOString()}</dd>
            </div>
            <div>
              <dt>Video</dt>
              <dd>{file.videoCodec ?? '—'}</dd>
            </div>
            <div>
              <dt>Audio</dt>
              <dd>{file.audioCodec ?? '—'}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{String(file.priority)}</dd>
            </div>
          </dl>

          <div className="file-detail-actions">
            <button type="button" disabled={requeueBusy} onClick={onRequeue}>
              {requeueBusy ? 'Requeuing…' : 'Requeue'}
            </button>
            <button type="button" disabled={priorityBusy} onClick={onRaisePriority}>
              {priorityBusy ? 'Raising…' : 'Raise priority'}
            </button>
            <button
              type="button"
              disabled={dryRunBusy || flowId === null}
              title={
                flowId === null
                  ? 'No run history — nothing to replay a flow against yet.'
                  : undefined
              }
              onClick={onDryRun}
            >
              {dryRunBusy ? 'Running dry-run…' : 'Dry-run'}
            </button>
          </div>

          {actionError !== null && (
            <p role="alert" className="file-detail-action-error">
              {actionError}
            </p>
          )}

          {dryRun !== null && (
            <div className="file-detail-dry-run">
              <p>
                {dryRun.complete
                  ? dryRun.wouldRunFfmpeg
                    ? 'The flow would run ffmpeg on this file.'
                    : 'The flow would leave this file alone.'
                  : `The walk stopped before finishing${
                      dryRun.stoppedBecause === null ? '.' : `: ${dryRun.stoppedBecause}`
                    }`}
              </p>
              {dryRun.executeDecisions.length > 0 && (
                <ul>
                  {dryRun.executeDecisions.map((decision) => (
                    <li key={decision.nodeId}>
                      {decision.nodeId}: {decision.skip ? 'skip' : 'run'} — {decision.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <h3>Streams</h3>
          {streams.length === 0 ? (
            <p className="help">No probe on record for this file yet.</p>
          ) : (
            <div className="stream-table-scroll">
              <table className="stream-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Kind</th>
                    <th>Codec</th>
                    <th>Detail</th>
                    <th>Language</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {streams.map((stream) => (
                    <tr key={stream.index}>
                      <td>{stream.index}</td>
                      <td>{stream.kind}</td>
                      <td>{stream.codec}</td>
                      <td>{stream.detail}</td>
                      <td>{stream.language}</td>
                      <td>{stream.duration}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>Job history</h3>
          {jobs.length === 0 ? (
            <p className="help">This file has never run.</p>
          ) : (
            <ul className="job-history">
              {jobs.map((job) => (
                <li key={job.id}>
                  <Link to={`/jobs/${job.id}`} navigate={navigate} className="job-history-row">
                    <span className="job-history-state">{job.state}</span>
                    <span className="job-history-reason">{job.outcome ?? '—'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
};
