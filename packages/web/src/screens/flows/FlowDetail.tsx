import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { describeFailure } from '../config/library-form-model.js';
import { toGraphRows, type FlowDefinition, type GraphRow } from './flow-graph-model.js';

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

const GraphNode = (props: { row: GraphRow }): JSX.Element => {
  const { row } = props;
  return (
    <li className="flow-graph-row" style={{ paddingLeft: `${String(row.depth * 1.25)}rem` }}>
      <div className="flow-graph-node">
        {row.branchLabel !== null && <span className="badge">{row.branchLabel}</span>}
        <code>{row.pluginId}</code>
        <span className="flow-graph-node-id">{row.nodeId}</span>
      </div>
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
 * labels, the twice-reachable node, the missing-start-node case); this file
 * stays a thin renderer over it.
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

  useEffect(() => {
    setFlow(null);
    setFailure(null);
    setLibraries(null);
    setCopied(false);
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
  // The list simply stays empty, which under-reports rather than lying.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await client.get<ApiLibraryStub[]>('/libraries');
        if (!cancelled) setLibraries(all.filter((library) => library.flowId === id));
      } catch {
        // Intentionally silent — see the comment above.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, id]);

  const rows = flow === null ? [] : toGraphRows(flow.definition);

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
                {libraries === null ? (
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
            <p className="help">This flow has no start node — nothing to draw.</p>
          ) : (
            <div className="flow-graph-scroll">
              <ol className="flow-graph">
                {rows.map((row) => (
                  <GraphNode key={row.nodeId} row={row} />
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
};
