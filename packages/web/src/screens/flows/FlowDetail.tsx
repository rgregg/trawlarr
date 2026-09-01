import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { formatRoute } from '../../shell/route.js';
import { describeFailure } from '../config/library-form-model.js';
import { toGraphRows, type FlowDefinition, type GraphRow } from './flow-graph-model.js';
import { toVersionRows, type ApiVersionSummary, type VersionRow } from './flow-version-model.js';

/**
 * `GET /flows/:id`'s shape, as `packages/server/src/api/routes/flows.ts`'s
 * `toFlowResource` actually returns it: flat, not wrapped in `{ flow: … }`
 * the way some resources in this API are, and `definition` is a real nested
 * object already — the daemon parses `definition_json` before answering, so
 * there is nothing here for this screen to `JSON.parse` itself.
 */
interface ApiFlowResource {
  id: string;
  name: string;
  description: string | null;
  tags: string;
  definition: FlowDefinition;
  definitionHash: string;
  createdAt: number;
  updatedAt: number;
}

/** The one field this screen needs from `GET /libraries` — see `watch-model.ts`. */
interface ApiLibraryStub {
  id: string;
  name: string;
  flowId: string | null;
}

const copyToClipboard = (text: string): Promise<void> | null => {
  const clipboard = (
    globalThis as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } }
  ).navigator?.clipboard;
  return clipboard === undefined ? null : clipboard.writeText(text);
};

/**
 * Exported so `FlowVersion.tsx` can draw a historical version's graph with
 * the exact same rendering — branch labels, the "also reached from" note,
 * the unreachable-node marker — rather than a second component drifting
 * from what this one does.
 */
export const GraphNode = (props: { row: GraphRow }): JSX.Element => {
  const { row } = props;
  return (
    <li
      className={`flow-graph-row${row.unreachable ? ' flow-graph-row-unreachable' : ''}`}
      style={{ paddingLeft: `${String(row.depth * 1.25)}rem` }}
    >
      <div className="flow-graph-node">
        {row.branchLabel !== null && <span className="badge">{row.branchLabel}</span>}
        {row.unreachable && <span className="badge badge-bad">not reached from the start</span>}
        <code>{row.pluginId}</code>
        <span className="flow-graph-node-id">{row.nodeId}</span>
      </div>
      {/* The other branches that reach this same node. Drawing it once is
          right — flows rejoin — but drawing it once with no mention of the
          second branch is how the muxqueue node, which sat on BOTH branches
          of a codec check, would render as though it were on one. */}
      {row.alsoReachedFrom.length > 0 && (
        <p className="flow-graph-also">Also reached from {row.alsoReachedFrom.join(', ')}</p>
      )}
      {row.inputs.length > 0 && (
        <dl className="flow-graph-inputs">
          {row.inputs.map((input) => (
            <div key={input.key}>
              <dt>{input.key}</dt>
              <dd>{input.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
};

/**
 * The flow detail screen: a flow, drawn — nothing to edit.
 *
 * READ-ONLY IS DELIBERATE, not a gap this task ran out of time for. Flow
 * editing needs its own design (what happens to a running job mid-edit, how
 * a partially-built graph is validated as you go) and is explicitly out of
 * scope for this whole redesign. What this screen owes an operator instead
 * is the one thing the JSON view never gave them: the graph, drawn with
 * branch labels, so a node hanging off the wrong output of a check is
 * visible rather than requiring someone to trace `edges` by hand — which is
 * exactly how the `-max_muxing_queue_size` node sat on both branches of a
 * codec check, undetected, while it queued ~9.2 TB of pointless rewrites.
 *
 * Deliberately untested, the same split every other detail screen in this
 * app uses (`JobDetail.tsx`, `FileDetail.tsx`): `flow-graph-model.ts` is
 * fully tested and carries every branch of the walk (indentation, branch
 * labels, the twice-reachable node and the other branches that reach it, the
 * node nothing reaches, and both undrawable definitions); this file stays a
 * thin renderer over it.
 */
export const FlowDetail = (props: {
  client: ApiClient;
  id: string;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, id } = props;

  const [flow, setFlow] = useState<ApiFlowResource | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Same derivation as `JobDetail.tsx`: loading is the absence of BOTH a
  // result and a failure, never a third flag that could drift from either.
  const loading = failure === null && flow === null;

  const [libraries, setLibraries] = useState<ApiLibraryStub[] | null>(null);
  const [copied, setCopied] = useState(false);

  // History gets the SAME failure/loading/empty split as the flow itself —
  // not the libraries panel's quieter inline text — because a broken
  // history fetch is something an operator retries, and a Retry button that
  // does not exist cannot be reached for.
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [versionsFailure, setVersionsFailure] = useState<ReturnType<typeof describeFailure> | null>(
    null,
  );
  const [versionsAttempt, setVersionsAttempt] = useState(0);
  const versionsLoading = versionsFailure === null && versions === null;

  useEffect(() => {
    setFlow(null);
    setFailure(null);
    setLibraries(null);
    setCopied(false);
    setVersions(null);
    setVersionsFailure(null);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<ApiFlowResource>(`/flows/${id}`);
        if (cancelled) return;
        setFlow(next);
        setFailure(null);
      } catch (error) {
        if (!cancelled) setFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, id, attempt]);

  // A SECONDARY fetch — which libraries use this flow — and its failure must
  // never blank a screen that already has the flow and its graph to show.
  // But it must not be SILENT either: `libraries === null` is the loading
  // state, rendered as "…", and a failed fetch used to leave it null for
  // ever, so the one place on this branch where loading, empty and failed
  // were indistinguishable rendered a permanent ellipsis. Three states, three
  // renderings.
  const [librariesFailed, setLibrariesFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await client.get<ApiLibraryStub[]>('/libraries');
        if (cancelled) return;
        setLibrariesFailed(false);
        setLibraries(all.filter((library) => library.flowId === id));
      } catch {
        if (!cancelled) setLibrariesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, id]);

  // ANOTHER independent, secondary fetch — a flow's history — with the same
  // rule as the libraries fetch above: this screen's job is to show the
  // flow and its graph, and a broken history request must not take that
  // away. It gets its OWN failure state rather than reusing `failure`
  // above, precisely so a history failure renders confined to the History
  // section instead of replacing the whole page with a Retry button for a
  // fetch the graph never needed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await client.get<{ items: ApiVersionSummary[] }>(
          `/flows/${id}/versions?limit=50`,
        );
        if (cancelled) return;
        setVersions(toVersionRows(page.items, Date.now()));
        setVersionsFailure(null);
      } catch (error) {
        if (!cancelled) setVersionsFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, id, versionsAttempt]);

  const rows = flow === null ? [] : toGraphRows(flow.definition);
  const currentVersion = versions?.find((version) => version.isCurrent) ?? null;

  const onCopy = (): void => {
    if (flow === null) return;
    const promise = copyToClipboard(JSON.stringify(flow.definition, null, 2));
    if (promise === null) return;
    void promise.then(() => {
      setCopied(true);
    });
  };

  return (
    <div className="flow-page">
      <Link to="/config?tab=libraries" navigate={props.navigate} className="flow-page-back">
        ← Configure
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
        <div className="flow-page-skeleton" aria-busy="true" aria-live="polite">
          <p className="help">Loading flow…</p>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}

      {failure === null && !loading && flow === null && (
        <div className="flow-page-empty">
          <p>No flow to show.</p>
        </div>
      )}

      {failure === null && !loading && flow !== null && (
        <>
          <div className="flow-page-header">
            <h2>{flow.name}</h2>
          </div>

          {flow.description !== null && flow.description !== '' && (
            <p className="flow-page-description">{flow.description}</p>
          )}

          <dl className="flow-page-meta">
            <div>
              <dt>Definition hash</dt>
              <dd>
                <code>{flow.definitionHash}</code>
              </dd>
            </div>
            <div>
              <dt>Libraries using this flow</dt>
              <dd>
                {librariesFailed ? (
                  'Could not be checked — the library list did not load.'
                ) : libraries === null ? (
                  '…'
                ) : libraries.length === 0 ? (
                  'None'
                ) : (
                  <ul className="flow-page-libraries">
                    {libraries.map((library) => (
                      <li key={library.id}>{library.name}</li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>

          <div role="note" className="flow-page-notice">
            Changing this flow changes its hash and re-queues every file that uses it. Flows are
            edited over the API or CLI, deliberately.
          </div>

          <div className="flow-page-actions">
            <button type="button" onClick={onCopy}>
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
          </div>

          <h3>Graph</h3>
          {rows.length === 0 ? (
            <p className="help">This flow has no nodes — nothing to draw.</p>
          ) : (
            <div className="flow-graph-scroll">
              <ol className="flow-graph">
                {rows.map((row) => (
                  <GraphNode key={row.nodeId} row={row} />
                ))}
              </ol>
            </div>
          )}

          <h3>History</h3>
          {versionsFailure !== null && (
            <div role="alert" className="failure">
              <strong>{versionsFailure.title}</strong>
              <p className="verbatim">{versionsFailure.message}</p>
              <button
                type="button"
                onClick={() => {
                  setVersionsAttempt((n) => n + 1);
                }}
              >
                Retry
              </button>
            </div>
          )}

          {versionsFailure === null && versionsLoading && <p className="help">Loading history…</p>}

          {versionsFailure === null &&
            !versionsLoading &&
            versions !== null &&
            versions.length === 0 && (
              <p className="help">This flow has never been published — there is no history yet.</p>
            )}

          {versionsFailure === null &&
            !versionsLoading &&
            versions !== null &&
            versions.length > 0 && (
              <ul className="flow-history">
                {versions.map((version) => (
                  <li key={version.id} className="flow-history-row">
                    <Link
                      to={formatRoute({ name: 'flowVersion', flowId: id, versionId: version.id })}
                      navigate={props.navigate}
                      className="flow-history-link"
                    >
                      <code>{version.shortHash}</code>
                      {version.isCurrent && <span className="badge">current</span>}
                      <span className="flow-history-note">{version.note}</span>
                      <span className="flow-history-when">{version.when}</span>
                    </Link>
                    {!version.isCurrent && currentVersion !== null && (
                      <Link
                        to={formatRoute({
                          name: 'flowCompare',
                          flowId: id,
                          from: version.id,
                          to: currentVersion.id,
                        })}
                        navigate={props.navigate}
                        className="flow-history-compare"
                      >
                        Compare with current
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </div>
  );
};
