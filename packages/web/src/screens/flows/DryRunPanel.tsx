import { Fragment, memo, useEffect, useRef, useState } from 'react';
import { ApiClientError, type ApiClient } from '../../api/client.js';
import { describeFailure } from '../config/library-form-model.js';
import {
  changeGroupLabel,
  formatCount,
  isRunStale,
  orderedCounts,
  progressText,
  routeText,
  walkFailure,
  type DryRunChangeGroup,
  type DryRunFileDetail,
  type DryRunOutcome,
  type DryRunRun,
  type DryRunWalk,
  type NodeLabels,
} from './dry-run-model.js';

const POLL_MS = 1000;

interface DryRunPanelProps {
  client: ApiClient;
  flowId: string;
  runId: string;
  canvasHash: string | null;
  liveHash: string;
  labels: NodeLabels;
  onRun: (run: DryRunRun) => void;
  onClose: () => void;
}

/** One half of a file's comparison: the route taken and the commands it would run. */
function Walk({
  name,
  walk,
  outcome,
  labels,
}: {
  name: string;
  walk: DryRunWalk | null;
  outcome: DryRunOutcome;
  labels: NodeLabels;
}): JSX.Element {
  const failure = walkFailure(walk, outcome);
  return (
    <div className="dry-run-walk">
      <p>
        <strong>{name}:</strong> {walk === null ? failure : routeText(walk, labels)}
      </p>
      {walk !== null && failure !== null && <p className="failure">{failure}</p>}
      {walk?.plannedCommands.map((command, index) => (
        <pre key={index}>{command.join(' ')}</pre>
      ))}
      {walk?.partialWalkWarning != null && <p className="detail">{walk.partialWalkWarning}</p>}
    </div>
  );
}

const groupKey = (group: DryRunChangeGroup): string =>
  `${JSON.stringify(group.from)}→${JSON.stringify(group.to)}`;

/**
 * The library dry run of the canvas, beside the published flow.
 *
 * Everything it shows is fetched: the event socket is liveness only, so the
 * run is polled while it walks, and the poll is torn down with the panel or
 * when a new run replaces this one — a leftover poll against a replaced run
 * would hand the editor an old run's numbers as the latest.
 */
export const DryRunPanel = memo(function DryRunPanel(props: DryRunPanelProps): JSX.Element {
  const { client, flowId, runId } = props;
  const [run, setRun] = useState<DryRunRun | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DryRunFileDetail | null>(null);
  const [detailFailure, setDetailFailure] = useState<string | null>(null);
  // A closed group renders no file rows: a library can put thousands in one
  // group, and every canvas edit re-renders this panel.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  // Through a ref so a new callback identity each editor render does not
  // restart the poll (and refetch) on every keystroke in the canvas.
  const onRun = useRef(props.onRun);
  onRun.current = props.onRun;

  const detailBox = useRef<HTMLLIElement>(null);
  // A run never goes back to running, so a poll that was in flight when
  // Cancel answered carries an older state and must not overwrite it.
  const settled = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = (): void => {
      void client.get<DryRunRun>(`/flows/${flowId}/dry-runs/${runId}`).then(
        (next) => {
          if (cancelled || settled.current) return;
          settled.current = next.status !== 'running';
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
  }, [client, flowId, runId]);

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

  // The answer is the run as it now stands: `cancelled`, or `done` when it
  // finished before the click landed, in which case its results are shown.
  const cancel = (): void => {
    void client.post<DryRunRun>(`/flows/${flowId}/dry-runs/${runId}/cancel`).then(
      (next) => {
        settled.current = next.status !== 'running';
        setRun(next);
        setFailure(null);
        onRun.current(next);
      },
      (error: unknown) => setFailure(describeFailure(error).message),
    );
  };

  // Leaving the run — Close, a newer run replacing this panel, or leaving the
  // editor — deletes it on the daemon, whatever its last known status: a
  // walking run would keep probing the library for nobody (and the first poll
  // may not have answered yet), and a finished one is only memory by now; the
  // Publish dialog keeps its own copy. A replaced run is already gone there,
  // so that DELETE's 404 is expected.
  const mounted = useRef(0);
  useEffect(() => {
    mounted.current += 1;
    return () => {
      mounted.current -= 1;
      // Deferred a tick: StrictMode rehearses an unmount on every mount in
      // development, and a DELETE sent from that rehearsal would cancel the
      // run the panel is about to show.
      window.setTimeout(() => {
        if (mounted.current === 0) {
          void client.del(`/flows/${flowId}/dry-runs/${runId}`).catch(() => undefined);
        }
      }, 0);
    };
  }, [client, flowId, runId]);

  const toggleGroup = (key: string, open: boolean): void =>
    setOpenGroups((current) => {
      if (current.has(key) === open) return current;
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

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
          <button type="button" onClick={props.onClose}>
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
            {orderedCounts(run.counts, props.labels).map((entry) => (
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
              <details
                key={groupKey(group)}
                onToggle={(event) => toggleGroup(groupKey(group), event.currentTarget.open)}
              >
                <summary>{changeGroupLabel(group, props.labels)}</summary>
                {openGroups.has(groupKey(group)) && (
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
                                <Walk
                                  name="Canvas"
                                  walk={detail.canvas}
                                  outcome={detail.outcome}
                                  labels={props.labels}
                                />
                                <Walk
                                  name="Published"
                                  walk={detail.published}
                                  outcome={detail.publishedOutcome}
                                  labels={props.labels}
                                />
                              </>
                            )}
                          </li>
                        )}
                      </Fragment>
                    ))}
                  </ul>
                )}
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
});
