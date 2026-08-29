import { useEffect, useState } from 'react';
import { diffFlowDefinitions, isEmptyDiff, type FlowDefinition } from '@trawlarr/core';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { formatRoute } from '../../shell/route.js';
import { describeFailure } from '../config/library-form-model.js';
import { formatWhen, toDiffLines, type DiffLine } from './flow-version-model.js';

/** Same wire shape as `FlowVersion.tsx`'s `ApiFlowVersion` — see that file. */
interface ApiFlowVersion {
  id: string;
  flowId: string;
  definitionHash: string;
  definition: FlowDefinition;
  note: string;
  createdAt: number;
}

const describeNote = (note: string): string => (note === '' ? 'Published' : note);

/** `+`/`−`/`~` before EVERY line, plus the colour class — colour is never
 * the only signal a line is a removal, an addition, or a change. */
const PREFIX: Record<DiffLine['kind'], string> = {
  'node-removed': '−',
  'edge-removed': '−',
  'node-added': '+',
  'edge-added': '+',
  'plugin-changed': '~',
  'input-changed': '~',
};

const CLASS: Record<DiffLine['kind'], string> = {
  'node-removed': 'flow-diff-line-removed',
  'edge-removed': 'flow-diff-line-removed',
  'node-added': 'flow-diff-line-added',
  'edge-added': 'flow-diff-line-added',
  'plugin-changed': 'flow-diff-line-changed',
  'input-changed': 'flow-diff-line-changed',
};

const VersionSummary = (props: { label: string; version: ApiFlowVersion }): JSX.Element => (
  <div className="flow-compare-side">
    <dt>{props.label}</dt>
    <dd>
      <code>{props.version.definitionHash.slice(0, 8)}</code> — {describeNote(props.version.note)},{' '}
      {formatWhen(props.version.createdAt, Date.now())}
    </dd>
  </div>
);

/**
 * Two versions of the same flow, diffed as a graph rather than as text —
 * `@trawlarr/core`'s `diffFlowDefinitions` exists precisely because the
 * `-max_muxing_queue_size` defect (one node on the wrong branch of a codec
 * check) was invisible in a JSON diff and obvious as one removed edge and
 * one added edge. This screen is that rendering's other end: `toDiffLines`
 * (`flow-version-model.ts`) carries every branch of the logic, tested, so
 * this file stays a thin `<ul>` over its output — the same split
 * `FlowDetail.tsx` uses for `toGraphRows`.
 *
 * `from`/`to` are nullable on the route (`route.ts`) so `/flows/:id/compare`
 * alone is a valid, linkable URL — an empty prompt rather than a dead end —
 * even though every link this app currently generates already fills both in
 * from `FlowDetail.tsx`'s History section.
 */
export const FlowCompare = (props: {
  client: ApiClient;
  flowId: string;
  from: string | null;
  to: string | null;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, flowId, from, to } = props;

  const [pair, setPair] = useState<{ from: ApiFlowVersion; to: ApiFlowVersion } | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loading = from !== null && to !== null && failure === null && pair === null;

  useEffect(() => {
    setPair(null);
    setFailure(null);
  }, [flowId, from, to]);

  useEffect(() => {
    if (from === null || to === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [fromVersion, toVersion] = await Promise.all([
          client.get<ApiFlowVersion>(`/flows/${flowId}/versions/${from}`),
          client.get<ApiFlowVersion>(`/flows/${flowId}/versions/${to}`),
        ]);
        if (cancelled) return;
        setPair({ from: fromVersion, to: toVersion });
        setFailure(null);
      } catch (error) {
        if (!cancelled) setFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, flowId, from, to, attempt]);

  const diff = pair === null ? null : diffFlowDefinitions(pair.from.definition, pair.to.definition);
  const diffLines = diff === null ? [] : toDiffLines(diff);
  const identical = diff !== null && isEmptyDiff(diff);

  return (
    <div className="flow-page">
      <Link
        to={formatRoute({ name: 'flow', id: flowId })}
        navigate={props.navigate}
        className="flow-page-back"
      >
        ← Back to flow
      </Link>

      <h2>Compare</h2>

      {(from === null || to === null) && (
        <div className="flow-page-empty">
          <p>Choose two versions to compare from the flow&rsquo;s History section.</p>
        </div>
      )}

      {from !== null && to !== null && failure !== null && (
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

      {from !== null && to !== null && failure === null && loading && (
        <div className="flow-page-skeleton" aria-busy="true" aria-live="polite">
          <p className="help">Loading both versions…</p>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}

      {from !== null && to !== null && failure === null && !loading && pair === null && (
        <div className="flow-page-empty">
          <p>No versions to compare.</p>
        </div>
      )}

      {pair !== null && (
        <>
          <dl className="flow-compare-meta">
            <VersionSummary label="From" version={pair.from} />
            <VersionSummary label="To" version={pair.to} />
          </dl>

          {identical ? (
            <p className="detail">
              These two versions are identical — the definition was published, changed, and
              published back to exactly what it was.
            </p>
          ) : (
            <ul className="flow-diff">
              {diffLines.map((line, index) => (
                <li
                  // Diff lines carry no stable id of their own — the ordering
                  // `toDiffLines` produces (removed before added, within each
                  // kind) is itself part of what makes a re-pointed edge read
                  // as a pair, so index is a safe key for this static list.
                  key={`${line.kind}-${String(index)}`}
                  className={`flow-diff-line ${CLASS[line.kind]}`}
                >
                  <span className="flow-diff-prefix" aria-hidden="true">
                    {PREFIX[line.kind]}
                  </span>
                  {line.text}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
};
