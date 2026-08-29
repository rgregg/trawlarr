import { useEffect, useState } from 'react';
import type { FlowDefinition } from '@trawlarr/core';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { formatRoute } from '../../shell/route.js';
import { describeFailure } from '../config/library-form-model.js';
import { GraphNode } from './FlowDetail.js';
import { toGraphRows } from './flow-graph-model.js';
import { formatWhen, type ApiVersionSummary } from './flow-version-model.js';

/**
 * `GET /flows/:id/versions/:versionId`'s shape — the full record, `definition`
 * included, unlike the list endpoint's summaries (`ApiVersionSummary`). The
 * `definition` here is `@trawlarr/core`'s stricter `FlowDefinition` — it
 * requires `pluginVersion` and non-optional `inputs` that the local, looser
 * copy in `flow-graph-model.ts` does not, and a value typed as the stricter
 * one is assignable to the looser one, which is all `toGraphRows` needs.
 */
interface ApiFlowVersion {
  id: string;
  flowId: string;
  definitionHash: string;
  definition: FlowDefinition;
  note: string;
  createdAt: number;
}

/** The one field this screen needs from `GET /libraries` — see `FlowDetail.tsx`. */
interface ApiLibraryStub {
  id: string;
  name: string;
  flowId: string | null;
}

type BlastRadius = { kind: 'loading' } | { kind: 'ready'; totalFiles: number } | { kind: 'failed' };

/**
 * One past version of a flow: read-only, drawn with the same graph renderer
 * as the live flow, and explicitly framed as historical unless it happens to
 * BE the live one — every row in `FlowDetail.tsx`'s History section links
 * here, the current row included, so this screen cannot assume it is always
 * looking at the past.
 *
 * Restore is the one action here, and it is a PUBLISH, not an undo: it
 * re-queues every file in every library bound to this flow for a rescan (see
 * `publishFlow` in `packages/server/src/api/routes/flows.ts`), which was
 * 5,194 files on the owner's real install for one restore. The confirmation
 * below states which libraries are affected and the exact file count before
 * the button to do it ever appears — it never estimates how many of those
 * files will actually re-encode, because that number is not cheaply
 * computable and a guess would be worse than saying nothing.
 */
export const FlowVersion = (props: {
  client: ApiClient;
  flowId: string;
  versionId: string;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, flowId, versionId } = props;

  const [version, setVersion] = useState<ApiFlowVersion | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loading = failure === null && version === null;

  useEffect(() => {
    setVersion(null);
    setFailure(null);
  }, [flowId, versionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<ApiFlowVersion>(`/flows/${flowId}/versions/${versionId}`);
        if (cancelled) return;
        setVersion(next);
        setFailure(null);
      } catch (error) {
        if (!cancelled) setFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, flowId, versionId, attempt]);

  // A SECONDARY fetch, same rule as `FlowDetail.tsx`'s libraries/history
  // fetches: whether this is the newest version decides how the page frames
  // itself and whether Restore/Compare make sense to offer, but its failure
  // must never blank a screen that already has the version to draw. Failure
  // — or a flow with no versions at all — falls back to `'unknown'`, which
  // this screen treats as "not provably current" rather than guessing.
  const [currentVersionId, setCurrentVersionId] = useState<string | null | 'unknown'>('unknown');
  useEffect(() => {
    let cancelled = false;
    setCurrentVersionId('unknown');
    void (async () => {
      try {
        const page = await client.get<{ items: ApiVersionSummary[] }>(
          `/flows/${flowId}/versions?limit=1`,
        );
        if (cancelled) return;
        setCurrentVersionId(page.items[0]?.id ?? null);
      } catch {
        if (!cancelled) setCurrentVersionId('unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, flowId]);

  const isCurrent = version !== null && currentVersionId === version.id;

  // ANOTHER secondary fetch — which libraries use this flow — needed only to
  // state Restore's blast radius. Same isolation as the two above: its
  // failure disables Restore's confirm (never a guessed count) without
  // touching the graph this screen exists to show.
  const [libraries, setLibraries] = useState<ApiLibraryStub[] | null>(null);
  const [librariesFailed, setLibrariesFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLibraries(null);
    setLibrariesFailed(false);
    void (async () => {
      try {
        const all = await client.get<ApiLibraryStub[]>('/libraries');
        if (cancelled) return;
        setLibraries(all.filter((library) => library.flowId === flowId));
      } catch {
        if (!cancelled) setLibrariesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, flowId]);

  // The exact re-queue count Restore's confirmation must state: the sum of
  // every affected library's file total, from `GET /files?libraryId=…`'s
  // `total` (the same field `Files.tsx` pages against) — not the number that
  // will re-encode, which nothing here claims to know.
  const [blastRadius, setBlastRadius] = useState<BlastRadius>({ kind: 'loading' });
  useEffect(() => {
    if (libraries === null) return;
    if (libraries.length === 0) {
      setBlastRadius({ kind: 'ready', totalFiles: 0 });
      return;
    }
    let cancelled = false;
    setBlastRadius({ kind: 'loading' });
    void (async () => {
      try {
        const pages = await Promise.all(
          libraries.map((library) =>
            client.get<{ total: number }>(`/files?libraryId=${library.id}&limit=1`),
          ),
        );
        if (cancelled) return;
        setBlastRadius({
          kind: 'ready',
          totalFiles: pages.reduce((sum, page) => sum + page.total, 0),
        });
      } catch {
        if (!cancelled) setBlastRadius({ kind: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, libraries]);

  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreFailure, setRestoreFailure] = useState<ReturnType<typeof describeFailure> | null>(
    null,
  );

  const restore = async (): Promise<void> => {
    setRestoring(true);
    setRestoreFailure(null);
    try {
      await client.post(`/flows/${flowId}/versions/${versionId}/restore`, {});
      props.navigate(formatRoute({ name: 'flow', id: flowId }));
    } catch (error) {
      setRestoreFailure(describeFailure(error));
    } finally {
      setRestoring(false);
    }
  };

  const rows = version === null ? [] : toGraphRows(version.definition);
  const libraryCountLabel = (count: number): string => `librar${count === 1 ? 'y' : 'ies'}`;

  return (
    <div className="flow-page">
      <Link
        to={formatRoute({ name: 'flow', id: flowId })}
        navigate={props.navigate}
        className="flow-page-back"
      >
        ← Back to flow
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
          <p className="help">Loading version…</p>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}

      {failure === null && !loading && version === null && (
        <div className="flow-page-empty">
          <p>No version to show.</p>
        </div>
      )}

      {failure === null && !loading && version !== null && (
        <>
          <div className="flow-page-header">
            <h2>
              Version <code>{version.definitionHash.slice(0, 8)}</code>
            </h2>
          </div>

          <div role="note" className="flow-page-notice">
            {isCurrent
              ? 'This is the current version of this flow — it is what runs today.'
              : 'This is a HISTORICAL version, not the one currently in effect. Restoring it ' +
                'publishes this definition again, as a brand-new version — the history is ' +
                'append-only, so restoring never rewrites or removes anything.'}
          </div>

          <dl className="flow-page-meta">
            <div>
              <dt>Note</dt>
              <dd>{version.note === '' ? 'Published' : version.note}</dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd>{formatWhen(version.createdAt, Date.now())}</dd>
            </div>
            <div>
              <dt>Definition hash</dt>
              <dd>
                <code>{version.definitionHash}</code>
              </dd>
            </div>
          </dl>

          {!isCurrent && typeof currentVersionId === 'string' && (
            <div className="flow-page-actions">
              <Link
                to={formatRoute({
                  name: 'flowCompare',
                  flowId,
                  from: version.id,
                  to: currentVersionId,
                })}
                navigate={props.navigate}
                className="flow-history-compare"
              >
                Compare with current
              </Link>
            </div>
          )}

          <h3>Graph</h3>
          {rows.length === 0 ? (
            <p className="help">This version has no nodes — nothing to draw.</p>
          ) : (
            <div className="flow-graph-scroll">
              <ol className="flow-graph">
                {rows.map((row) => (
                  <GraphNode key={row.nodeId} row={row} />
                ))}
              </ol>
            </div>
          )}

          {!isCurrent && (
            <>
              <h3>Restore</h3>
              <p className="help">
                Restoring re-queues every file in every library bound to this flow, so trawlarr can
                re-derive convergence under the restored definition. Whether a given file actually
                needs re-encoding is decided per file once that runs — this cannot be known ahead of
                time and is not estimated here.
              </p>

              {librariesFailed && (
                <p className="detail">
                  Could not check which libraries use this flow — Restore is unavailable until this
                  can be checked.
                </p>
              )}

              {!librariesFailed && libraries !== null && blastRadius.kind === 'loading' && (
                <p className="detail">Checking how many files would re-queue…</p>
              )}

              {!librariesFailed && libraries !== null && blastRadius.kind === 'failed' && (
                <p className="detail">
                  Could not determine how many files would re-queue — Restore is unavailable until
                  this can be checked.
                </p>
              )}

              {!librariesFailed && libraries !== null && blastRadius.kind === 'ready' && (
                <>
                  <p className="trash-total">
                    {libraries.length === 0 ? (
                      'No library currently uses this flow — restoring would re-queue nothing.'
                    ) : (
                      <>
                        Restoring now would re-queue{' '}
                        <strong>{String(blastRadius.totalFiles)} file(s)</strong> across{' '}
                        <strong>
                          {String(libraries.length)} {libraryCountLabel(libraries.length)}
                        </strong>
                        :
                      </>
                    )}
                  </p>

                  {libraries.length > 0 && (
                    <ul className="flow-page-libraries">
                      {libraries.map((library) => (
                        <li key={library.id}>{library.name}</li>
                      ))}
                    </ul>
                  )}

                  {!confirming ? (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirming(true);
                      }}
                    >
                      Restore this version…
                    </button>
                  ) : (
                    <div role="alert" className="failure trash-confirm">
                      <strong>Restoring publishes this definition again, as a new version.</strong>
                      <p>
                        {blastRadius.totalFiles === 0
                          ? 'No files will be re-queued — no library currently uses this flow.'
                          : `${String(blastRadius.totalFiles)} file(s) across ${String(
                              libraries.length,
                            )} ${libraryCountLabel(libraries.length)} will be re-queued for a ` +
                            'rescan. How many will actually need re-encoding is not known ahead ' +
                            'of time.'}
                      </p>
                      <div className="row-actions">
                        <button type="button" disabled={restoring} onClick={() => void restore()}>
                          {restoring
                            ? 'Restoring…'
                            : blastRadius.totalFiles === 0
                              ? 'Yes, restore'
                              : `Yes, restore and re-queue ${String(blastRadius.totalFiles)} file(s)`}
                        </button>
                        <button
                          type="button"
                          disabled={restoring}
                          onClick={() => {
                            setConfirming(false);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {restoreFailure !== null && (
                <div role="alert" className="failure">
                  <strong>{restoreFailure.title}</strong>
                  <p className="verbatim">{restoreFailure.message}</p>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};
