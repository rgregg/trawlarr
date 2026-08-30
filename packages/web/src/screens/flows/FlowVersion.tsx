import { useEffect, useState } from 'react';
import type { FlowDefinition } from '@trawlarr/core';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { formatRoute } from '../../shell/route.js';
import { describeFailure } from '../config/library-form-model.js';
import { GraphNode } from './FlowDetail.js';
import { toGraphRows } from './flow-graph-model.js';
import {
  describeRestoreConfirmation,
  describeRestorePreview,
  describeVersionNotice,
  formatWhen,
  isRestoreNoOp,
  resolveVersionStatus,
  restoreButtonLabel,
  type ApiVersionSummary,
  type CurrentVersionState,
} from './flow-version-model.js';

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
 *
 * REACHED TWO WAYS, per `route.ts`'s `flowVersion` and `flowVersionDirect`.
 * `FlowDetail.tsx`'s History section already knows the flow, so it passes
 * `flowId` and this fetches `GET /flows/:id/versions/:versionId` exactly as
 * before Task 8. `JobDetail.tsx` knows only a job's `flowHash`, resolved to
 * a bare version id through `GET /flows/versions/by-hash/:hash` — it has no
 * flow id to hand over, so `flowId` is `null` there and this fetches
 * `GET /flows/versions/:versionId` instead, a route that needs none. Either
 * way the response carries `flowId` (see `ApiFlowVersion` below), which is
 * ALL this screen actually needs it for — the back-link, "Compare with
 * current" and Restore all resolve `resolvedFlowId` from the fetched
 * version once it lands, rather than duplicating a second source of truth
 * for "which flow" that could disagree with what was fetched.
 */
export const FlowVersion = (props: {
  client: ApiClient;
  flowId: string | null;
  versionId: string;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, flowId, versionId } = props;

  const [version, setVersion] = useState<ApiFlowVersion | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loading = failure === null && version === null;

  // Known immediately when reached via `flowVersion` (the prop is set);
  // known only once the fetch below resolves when reached via
  // `flowVersionDirect` (the prop is `null` and this waits on `version`).
  const resolvedFlowId = flowId ?? version?.flowId ?? null;

  useEffect(() => {
    setVersion(null);
    setFailure(null);
  }, [flowId, versionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const path =
          flowId !== null
            ? `/flows/${flowId}/versions/${versionId}`
            : `/flows/versions/${versionId}`;
        const next = await client.get<ApiFlowVersion>(path);
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
  // must never blank a screen that already has the version to draw.
  //
  // `CurrentVersionState` (see `flow-version-model.ts`) keeps "still
  // loading" and "the fetch failed" as two distinct states rather than
  // collapsing both into one sentinel — collapsing them was the bug: a
  // failed lookup used to render identically to "checked, and it turned out
  // not to be current", so this page asserted HISTORICAL, and offered
  // Restore, for a version it had simply failed to check. `resolveVersionStatus`
  // turns this state plus the version id into the one of four states the
  // page actually renders.
  //
  // The `hash` carried alongside `id` is what `isRestoreNoOp` below compares
  // against this version's own hash — a DIFFERENT version row can be current
  // by id while this one is still a no-op to restore by hash (publish A,
  // then B, then A again: id changed, hash didn't).
  const [currentVersion, setCurrentVersion] = useState<CurrentVersionState>({ kind: 'loading' });
  const [currentAttempt, setCurrentAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setCurrentVersion({ kind: 'loading' });
    // Reached via `flowVersionDirect`, `resolvedFlowId` is `null` until the
    // primary fetch above resolves it — this simply waits for that render
    // rather than guessing.
    if (resolvedFlowId === null) return;
    void (async () => {
      try {
        const page = await client.get<{ items: ApiVersionSummary[] }>(
          `/flows/${resolvedFlowId}/versions?limit=1`,
        );
        if (cancelled) return;
        const top = page.items[0];
        setCurrentVersion({
          kind: 'known',
          id: top?.id ?? null,
          hash: top?.definitionHash ?? null,
        });
      } catch {
        if (!cancelled) setCurrentVersion({ kind: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, resolvedFlowId, currentAttempt]);

  const status = version === null ? 'loading' : resolveVersionStatus(currentVersion, version.id);

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
    if (resolvedFlowId === null) return;
    void (async () => {
      try {
        const all = await client.get<ApiLibraryStub[]>('/libraries');
        if (cancelled) return;
        setLibraries(all.filter((library) => library.flowId === resolvedFlowId));
      } catch {
        if (!cancelled) setLibrariesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, resolvedFlowId]);

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
    // Guarded defensively — the Restore button below only ever renders once
    // `version` is loaded, at which point `resolvedFlowId` is always a
    // string (either the prop, or `version.flowId`).
    if (resolvedFlowId === null) return;
    setRestoring(true);
    setRestoreFailure(null);
    try {
      await client.post(`/flows/${resolvedFlowId}/versions/${versionId}/restore`, {});
      props.navigate(formatRoute({ name: 'flow', id: resolvedFlowId }));
    } catch (error) {
      setRestoreFailure(describeFailure(error));
    } finally {
      setRestoring(false);
    }
  };

  const rows = version === null ? [] : toGraphRows(version.definition);
  const noOp = version !== null && isRestoreNoOp(currentVersion, version.definitionHash);

  return (
    <div className="flow-page">
      {/* Waits on `resolvedFlowId` the same way `JobDetail.tsx`'s back-link
          waits on `detail`: reached via `flowVersionDirect` there is no
          flow id to point at until the version itself has loaded, and a
          link to `undefined` is a worse answer than no link yet. */}
      {resolvedFlowId !== null && (
        <Link
          to={formatRoute({ name: 'flow', id: resolvedFlowId })}
          navigate={props.navigate}
          className="flow-page-back"
        >
          ← Back to flow
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
            {describeVersionNotice(status)}
          </div>

          {status === 'failed' && (
            <p className="detail">
              <button
                type="button"
                onClick={() => {
                  setCurrentAttempt((n) => n + 1);
                }}
              >
                Retry
              </button>
            </p>
          )}

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

          {status === 'historical' &&
            currentVersion.kind === 'known' &&
            currentVersion.id !== null && (
              <div className="flow-page-actions">
                <Link
                  to={formatRoute({
                    name: 'flowCompare',
                    flowId: version.flowId,
                    from: version.id,
                    to: currentVersion.id,
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

          {status === 'historical' && (
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
                  {(() => {
                    const preview = {
                      isNoOp: noOp,
                      totalFiles: blastRadius.totalFiles,
                      libraryCount: libraries.length,
                    };
                    return (
                      <>
                        <p className="trash-total">{describeRestorePreview(preview)}</p>

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
                            <strong>
                              Restoring publishes this definition again, as a new version.
                            </strong>
                            <p>{describeRestoreConfirmation(preview)}</p>
                            <div className="row-actions">
                              <button
                                type="button"
                                disabled={restoring}
                                onClick={() => void restore()}
                              >
                                {restoreButtonLabel(preview, restoring)}
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
                    );
                  })()}
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
