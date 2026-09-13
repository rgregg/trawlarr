import { Fragment, useEffect, useRef, useState } from 'react';
import { ApiClientError, type ApiClient } from '../../api/client.js';
import { describeFailure } from '../config/library-form-model.js';
import {
  changeGroupLabel,
  formatCount,
  isRunStale,
  orderedCounts,
  progressText,
  routeText,
  type DryRunFileDetail,
  type DryRunRun,
  type DryRunWalk,
} from './dry-run-model.js';

const POLL_MS = 1000;

interface DryRunPanelProps {
  client: ApiClient;
  flowId: string;
  runId: string;
  canvasHash: string | null;
  liveHash: string;
  labels: Record<string, string>;
  onRun: (run: DryRunRun) => void;
  onClose: () => void;
}

/** One half of a file's comparison: the route taken and the commands it would run. */
function Walk({
  name,
  walk,
  labels,
}: {
  name: string;
  walk: DryRunWalk | null;
  labels: Record<string, string>;
}): JSX.Element {
  return (
    <div className="dry-run-walk">
      <p>
        <strong>{name}:</strong> {walk === null ? 'Walk failed' : routeText(walk, labels)}
      </p>
      {walk?.plannedCommands.map((command, index) => (
        <pre key={index}>{command.join(' ')}</pre>
      ))}
      {walk?.partialWalkWarning != null && <p className="detail">{walk.partialWalkWarning}</p>}
    </div>
  );
}

/**
 * The library dry run of the canvas, beside the published flow.
 *
 * Everything it shows is fetched: the event socket is liveness only, so the
 * run is polled while it walks, and the poll is torn down with the panel or
 * when a new run replaces this one — a leftover poll against a replaced run
 * would hand the editor an old run's numbers as the latest.
 */
export function DryRunPanel(props: DryRunPanelProps): JSX.Element {
  const { client, flowId, runId } = props;
  const [run, setRun] = useState<DryRunRun | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DryRunFileDetail | null>(null);
  const [detailFailure, setDetailFailure] = useState<string | null>(null);
  // Through a ref so a new callback identity each editor render does not
  // restart the poll (and refetch) on every keystroke in the canvas.
  const onRun = useRef(props.onRun);
  onRun.current = props.onRun;

  const detailBox = useRef<HTMLLIElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = (): void => {
      void client.get<DryRunRun>(`/flows/${flowId}/dry-runs/${runId}`).then(
        (next) => {
          if (cancelled) return;
          setRun(next);
          setFailure(null);
          onRun.current(next);
          if (next.status === 'running') timer = window.setTimeout(poll, POLL_MS);
        },
        (error: unknown) => {
          if (cancelled) return;
          setFailure(describeFailure(error).message);
          // Only a 404 ends the poll: a daemon restart forgets runs, and
          // retrying one every second would never end. Anything else is
          // treated as a blip — stopping on it froze the panel at "running"
          // and left the Publish dialog without counts for good.
          if (!(error instanceof ApiClientError && error.status === 404)) {
            timer = window.setTimeout(poll, POLL_MS);
          }
        },
      );
    };
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, flowId, runId, refresh]);

  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    setDetail(null);
    setDetailFailure(null);
    void client.get<DryRunFileDetail>(`/flows/${flowId}/dry-runs/${runId}/files/${selected}`).then(
      (next) => {
        if (!cancelled) setDetail(next);
      },
      (error: unknown) => {
        if (!cancelled) setDetailFailure(describeFailure(error).message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, flowId, runId, selected]);

  // A group can hold thousands of files; the detail opens under the clicked
  // row, and is scrolled to once it has content so a click never looks inert.
  useEffect(() => {
    if (detail !== null || detailFailure !== null) {
      detailBox.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [detail, detailFailure]);

  const cancel = (): void => {
    void client.del(`/flows/${flowId}/dry-runs/${runId}`).then(
      () => setRefresh((value) => value + 1),
      (error: unknown) => setFailure(describeFailure(error).message),
    );
  };

  const close = (): void => {
    // Closing a walking run stops it on the daemon too: nobody is left to
    // read the result, and it would keep probing the library for nothing.
    if (run?.status === 'running')
      void client.del(`/flows/${flowId}/dry-runs/${runId}`).catch(() => undefined);
    props.onClose();
  };

  const stale = run !== null && isRunStale(run, props.canvasHash, props.liveHash);

  return (
    <section
      className="dry-run-panel"
      aria-labelledby="dry-run-heading"
      aria-busy={run?.status === 'running'}
    >
      <div className="dry-run-heading">
        <h2 id="dry-run-heading">
          {run === null
            ? 'Dry run'
            : run.status === 'done'
              ? `Dry run · ${formatCount(run.total)} files`
              : progressText(run)}
        </h2>
        {stale && <span className="badge dry-run-stale">Out of date</span>}
        <div className="row-actions">
          {run?.status === 'running' && (
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          )}
          <button type="button" onClick={close}>
            Close
          </button>
        </div>
      </div>
      {failure !== null && (
        <p role="alert" className="failure">
          {failure}
        </p>
      )}
      {run?.status === 'failed' && (
        <p role="alert" className="failure">
          {run.error}
        </p>
      )}
      {run?.status === 'cancelled' && (
        <p className="detail">
          Cancelled at {formatCount(run.processed)} / {formatCount(run.total)}.
        </p>
      )}
      {run?.status === 'done' && (
        <>
          <ul className="dry-run-counts">
            {orderedCounts(run.counts).map((entry) => (
              <li key={entry.key}>
                <span>{entry.label}</span>
                <strong>{formatCount(entry.count)}</strong>
              </li>
            ))}
          </ul>
          <h3>Changes vs published</h3>
          {run.changes.length === 0 ? (
            <p className="detail">Same outcome as published for every file.</p>
          ) : (
            run.changes.map((group) => (
              <details key={`${JSON.stringify(group.from)}→${JSON.stringify(group.to)}`}>
                <summary>{changeGroupLabel(group)}</summary>
                <ul className="dry-run-files">
                  {group.files.map((file) => (
                    <Fragment key={file.fileId}>
                      <li>
                        <button
                          type="button"
                          title={file.path}
                          aria-pressed={selected === file.fileId}
                          aria-expanded={selected === file.fileId}
                          onClick={() => setSelected(file.fileId)}
                        >
                          {file.path}
                        </button>
                      </li>
                      {selected === file.fileId && (
                        <li className="dry-run-detail" ref={detailBox}>
                          {detailFailure !== null ? (
                            <p role="alert" className="failure">
                              {detailFailure}
                            </p>
                          ) : detail === null ? (
                            <p aria-busy="true">Loading…</p>
                          ) : (
                            <>
                              <Walk name="Canvas" walk={detail.canvas} labels={props.labels} />
                              <Walk
                                name="Published"
                                walk={detail.published}
                                labels={props.labels}
                              />
                            </>
                          )}
                        </li>
                      )}
                    </Fragment>
                  ))}
                </ul>
              </details>
            ))
          )}
        </>
      )}
      <p className="detail dry-run-limits">
        Walks stop at community nodes the engine can&apos;t vouch for. Size checks aren&apos;t
        measured.
      </p>
    </section>
  );
}
