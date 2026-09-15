import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import type { LiveState } from '../../api/events.js';
import { Link } from '../../shell/Link.js';
import { formatRoute } from '../../shell/route.js';
import { formatWhen } from '../../shell/time.js';
import { describeFailure } from './library-form-model.js';
import {
  joinCommand,
  nodeCardLine,
  nodeSettingsEditable,
  pausedShown,
  nodeStatus,
  nodesRefreshKey,
  pathMapRows,
  unreachableSummary,
  validatePathMapRows,
  type NodeMutationResponse,
  type NodeResource,
} from './nodes-model.js';

/**
 * `GET /system/version`'s `commit` field — what the join dialog's
 * `docker run` command pins its image tag to. Declared narrowly here rather
 * than pulling in `VersionResource` from `Config.tsx`, the same way every
 * other section on this screen only imports the one field it reads.
 */
interface VersionInfo {
  commit: string | null;
}

const copyToClipboard = (text: string): Promise<void> | null => {
  const clipboard = (
    globalThis as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } }
  ).navigator?.clipboard;
  return clipboard === undefined ? null : clipboard.writeText(text);
};

const CopyableCommand = (props: { command: string }): JSX.Element => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="node-command">
      <code className="verbatim">{props.command}</code>
      <button
        type="button"
        onClick={() => {
          const promise = copyToClipboard(props.command);
          if (promise === null) return;
          void promise.then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
};

/**
 * The dialog `POST /nodes` hands back once and never again: the enrollment
 * token this node needs to authenticate itself before it has a secret of
 * its own. There is no "show me that again" — a lost token means creating
 * a new node (or `POST /nodes/:id/enroll-token`, not built here).
 */
const JoinDialog = (props: {
  name: string;
  serverUrl: string;
  token: string;
  commit: string | null;
  onDone: () => void;
}): JSX.Element => {
  const commands = joinCommand({
    serverUrl: props.serverUrl,
    token: props.token,
    commit: props.commit,
  });
  return (
    <div role="alert" className="config-section node-join-dialog">
      <h3>Add {props.name} on the new machine</h3>
      <p className="help">Expires in 24 h. Run one of these there.</p>
      <p className="detail">Docker</p>
      <CopyableCommand command={commands.docker} />
      <p className="detail">CLI</p>
      <CopyableCommand command={commands.cli} />
      <div className="row-actions">
        <button type="button" className="btn-primary" onClick={props.onDone}>
          Done
        </button>
      </div>
    </div>
  );
};

/** A path-map row mid-edit — a draft, never written until Save. */
interface PathRowDraft {
  key: string;
  serverPath: string;
  nodePath: string;
}

const newRowKey = (): string => {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID !== undefined) return cryptoObj.randomUUID();
  return `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const NodeDetail = (props: {
  client: ApiClient;
  node: NodeResource;
  libraryNames: Record<string, string>;
  /**
   * Fired after every successful mutation. The ONLY way this screen learns
   * a mutation succeeded is by re-fetching `GET /nodes` — never by reading
   * the mutation's own response as a row. `POST /nodes`, `PUT /nodes/:id`
   * and `POST /nodes/:id/revoke` all return the bare `toNodeResource(...)`
   * shape (`NodeMutationResponse` below): no `local`/`online`/`running`,
   * because only the LIST handler joins those on
   * (`packages/server/src/api/routes/nodes.ts`). Passing that response
   * straight into row state is exactly what made `node.running.length`
   * throw on every one of Save workers / Toggle paused / Save paths /
   * Revoke — this callback is the fix: it asks the parent to reload the
   * real list instead.
   */
  onMutated: () => void;
}): JSX.Element => {
  const { client, node } = props;
  const [workerInput, setWorkerInput] = useState(String(node.schedule.baseCounts.transcode));
  const [rows, setRows] = useState<PathRowDraft[]>(() =>
    pathMapRows(node.pathMap).map((row) => ({ ...row })),
  );
  const [rowsProblem, setRowsProblem] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [pausedDraft, setPausedDraft] = useState<boolean | null>(null);
  const paused = pausedShown({ draft: pausedDraft, saved: node.paused });
  // Drop the draft once the reloaded row agrees with it.
  useEffect(() => {
    if (paused.draft !== pausedDraft) setPausedDraft(paused.draft);
  }, [paused.draft, pausedDraft]);
  const editable = nodeSettingsEditable(node);

  const run = async (call: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await call();
      props.onMutated();
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const saveWorkerCount = async (): Promise<void> => {
    const trimmed = workerInput.trim();
    if (!/^\d+$/.test(trimmed)) {
      setFailure({
        title: 'Not a number of workers',
        message: 'Enter a whole number of workers.',
        retryable: false,
      });
      return;
    }
    await run(async () => {
      // Typed as the MUTATION response, never `NodeResource`: it has no
      // `running`/`online`/`local`, so nothing here can mistake it for a row.
      await client.put<NodeMutationResponse>(`/nodes/${node.id}`, {
        schedule: {
          ...node.schedule,
          baseCounts: { ...node.schedule.baseCounts, transcode: Number(trimmed) },
        },
      });
    });
  };

  const togglePaused = async (next: boolean): Promise<void> => {
    setPausedDraft(next);
    await run(async () => {
      try {
        await client.put<NodeMutationResponse>(`/nodes/${node.id}`, { paused: next });
      } catch (error) {
        setPausedDraft(null);
        throw error;
      }
    });
  };

  const savePaths = async (): Promise<void> => {
    const plain = rows.map((row) => ({ serverPath: row.serverPath, nodePath: row.nodePath }));
    const problem = validatePathMapRows(plain);
    if (problem !== null) {
      setRowsProblem(problem);
      return;
    }
    setRowsProblem(null);
    await run(async () => {
      const updated = await client.put<NodeMutationResponse>(`/nodes/${node.id}`, {
        pathMap: plain,
      });
      // Reading `pathMap` off the mutation response is fine — it is a real
      // field on that shape, just not the `local`/`online`/`running` trio
      // that made it unsafe to treat as a row. Read here, never passed to
      // `onMutated` or any row-shaped state.
      setRows(pathMapRows(updated.pathMap).map((row) => ({ ...row })));
    });
  };

  const revoke = async (): Promise<void> => {
    await run(async () => {
      await client.post<NodeMutationResponse>(`/nodes/${node.id}/revoke`, {});
      setConfirmingRevoke(false);
    });
  };

  const remove = async (): Promise<void> => {
    await run(async () => {
      await client.del(`/nodes/${node.id}`);
    });
  };

  const canDelete = node.revokedAt !== null || !node.enrolled;

  return (
    <div className="node-detail">
      <div className="node-detail-section">
        <label htmlFor={`node-${node.id}-workers`}>Transcode workers</label>
        <div className="node-worker-count">
          <input
            id={`node-${node.id}-workers`}
            inputMode="numeric"
            readOnly={!editable}
            value={workerInput}
            onChange={(event) => {
              setWorkerInput(event.target.value);
            }}
          />
          {editable && (
            <button type="button" disabled={busy} onClick={() => void saveWorkerCount()}>
              Save
            </button>
          )}
        </div>
      </div>

      <label className="switch">
        <input
          type="checkbox"
          checked={paused.checked}
          disabled={busy || !editable}
          onChange={(event) => void togglePaused(event.target.checked)}
        />
        Paused
      </label>

      <div className="node-detail-section">
        <h4>Paths</h4>
        <table className="node-path-table">
          <thead>
            <tr>
              <th>Server path</th>
              <th>This node&rsquo;s path</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <input
                    readOnly={!editable}
                    value={row.serverPath}
                    onChange={(event) => {
                      setRows((current) =>
                        current.map((candidate) =>
                          candidate.key === row.key
                            ? { ...candidate, serverPath: event.target.value }
                            : candidate,
                        ),
                      );
                    }}
                  />
                </td>
                <td>
                  <input
                    readOnly={!editable}
                    value={row.nodePath}
                    onChange={(event) => {
                      setRows((current) =>
                        current.map((candidate) =>
                          candidate.key === row.key
                            ? { ...candidate, nodePath: event.target.value }
                            : candidate,
                        ),
                      );
                    }}
                  />
                </td>
                <td>
                  {editable && (
                    <button
                      type="button"
                      onClick={() => {
                        setRows((current) =>
                          current.filter((candidate) => candidate.key !== row.key),
                        );
                      }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {editable && (
          <div className="row-actions">
            <button
              type="button"
              onClick={() => {
                setRows((current) => [
                  ...current,
                  { key: newRowKey(), serverPath: '', nodePath: '' },
                ]);
              }}
            >
              Add row
            </button>
            <button type="button" disabled={busy} onClick={() => void savePaths()}>
              Save paths
            </button>
          </div>
        )}
        {rowsProblem !== null && <p className="problems">{rowsProblem}</p>}
        {rowsProblem === null && node.pathMapError !== null && (
          <p className="problems">{node.pathMapError}</p>
        )}
      </div>

      <div className="node-detail-section">
        <h4>Libraries</h4>
        {node.libraries.length === 0 ? (
          <p className="detail">No libraries probed yet.</p>
        ) : (
          <ul className="node-library-list">
            {node.libraries.map((probe) => (
              <li
                key={probe.libraryId}
                className={probe.reachable ? 'node-lib-ok' : 'node-lib-bad'}
              >
                <strong>{props.libraryNames[probe.libraryId] ?? probe.libraryId}</strong>
                {probe.reachable ? ' ✓' : `: ${probe.detail}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="node-detail-section">
        <h4>Hardware</h4>
        {node.hardwareTypes.length === 0 ? (
          <p className="detail">None declared.</p>
        ) : (
          <p className="detail">
            {node.hardwareTypes
              .map((type) => {
                const cap = node.hardwareCaps[type];
                return cap === undefined ? type : `${type} (${String(cap)})`;
              })
              .join(', ')}
          </p>
        )}
      </div>

      <div className="row-actions">
        {node.revokedAt === null ? (
          !confirmingRevoke ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmingRevoke(true);
              }}
            >
              Revoke
            </button>
          ) : (
            <>
              <span className="detail">Revoke this node? It can no longer authenticate.</span>
              <button type="button" disabled={busy} onClick={() => void revoke()}>
                Yes, revoke
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmingRevoke(false);
                }}
              >
                Cancel
              </button>
            </>
          )
        ) : (
          <span className="detail">Revoked {formatWhen(node.revokedAt, Date.now())}</span>
        )}
        {canDelete && (
          <button type="button" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>

      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
        </div>
      )}
    </div>
  );
};

const NodeRow = (props: {
  client: ApiClient;
  node: NodeResource;
  libraryNames: Record<string, string>;
  navigate: (to: string) => void;
  expanded: boolean;
  onToggle: () => void;
  onMutated: () => void;
}): JSX.Element => {
  const { node } = props;
  const status = nodeStatus(node);
  const unreachable = unreachableSummary(node, props.libraryNames);

  if (node.local) {
    return (
      <li className="card node-card status-idle">
        <div className="node-card-head">
          <h3>{node.name}</h3>
          <p className="badge">This daemon</p>
        </div>
        <p className="detail">
          {String(node.running.length)} running.{' '}
          <Link to={formatRoute({ name: 'config', tab: 'workers' })} navigate={props.navigate}>
            Workers
          </Link>
        </p>
      </li>
    );
  }

  const statusClass =
    status === 'Online'
      ? 'status-converged'
      : status === 'Revoked'
        ? 'status-attention'
        : status === 'Waiting to join'
          ? 'status-paused'
          : 'status-idle';

  return (
    <li className={`card node-card ${statusClass}`}>
      <div className="node-card-head">
        <h3>{node.name}</h3>
        <p className="badge">{status}</p>
      </div>
      <p className="detail">{nodeCardLine(node, Date.now())}</p>
      {unreachable.length > 0 && <p className="problems">Unreachable: {unreachable.join('; ')}</p>}
      <div className="row-actions">
        <button type="button" onClick={props.onToggle}>
          {props.expanded ? 'Hide details' : 'Details'}
        </button>
      </div>
      {props.expanded && (
        <NodeDetail
          client={props.client}
          node={node}
          libraryNames={props.libraryNames}
          onMutated={props.onMutated}
        />
      )}
    </li>
  );
};

type View = { kind: 'list' } | { kind: 'adding' } | { kind: 'join'; name: string; token: string };

/**
 * The Nodes tab: every node this daemon knows about — the local one first,
 * read-only, then every remote node it has enrolled or is waiting to.
 */
export const Nodes = (props: {
  client: ApiClient;
  live: LiveState;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client } = props;
  const stale = nodesRefreshKey(props.live);
  const [nodes, setNodes] = useState<NodeResource[] | null>(null);
  const [libraryNames, setLibraryNames] = useState<Record<string, string>>({});
  const [commit, setCommit] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addName, setAddName] = useState('');
  const [addFailure, setAddFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [adding, setAdding] = useState(false);

  // The ONLY place `nodes` state is written from the network. Every mutation
  // (Add node, Save workers, Toggle paused, Save paths, Revoke, Delete) ends
  // by calling this again rather than by merging its own response into
  // state — see `NodeDetail`'s `onMutated` doc comment for why a mutation's
  // response is never a safe substitute for a real list row.
  const reload = async (): Promise<void> => {
    try {
      const next = await client.get<NodeResource[]>('/nodes');
      setProblem(null);
      setNodes(next);
      setExpandedId((current) =>
        current !== null && next.some((node) => node.id === current) ? current : null,
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<NodeResource[]>('/nodes');
        if (cancelled) return;
        setProblem(null);
        setNodes(next);
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, stale, attempt]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const libraries = await client.get<Array<{ id: string; name: string }>>('/libraries');
        if (cancelled) return;
        setLibraryNames(Object.fromEntries(libraries.map((lib) => [lib.id, lib.name])));
      } catch {
        // A library-name blip must not fail the whole tab: rows fall back to
        // printing the library id, same as the Libraries tab's own flow names.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await client.get<VersionInfo>('/system/version');
        if (cancelled) return;
        setCommit(info.commit);
      } catch {
        // Same as above: the join dialog just has nothing to pin if this
        // fails, which is caught before the dialog opens (see `createNode`).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const createNode = async (): Promise<void> => {
    const name = addName.trim();
    if (name === '') {
      setAddFailure({
        title: 'Give it a name',
        message: 'Enter a name for this node.',
        retryable: false,
      });
      return;
    }
    setAdding(true);
    setAddFailure(null);
    try {
      // `POST /nodes`'s `node` field is a MUTATION response (`NodeMutationResponse`
      // — no `local`/`online`/`running`), so only its `name` and the token/expiry
      // are kept for the dialog. The list itself is refreshed by `reload()`,
      // which is what actually adds a row for the new node.
      const answer = await client.post<{
        node: NodeMutationResponse;
        enrollToken: string;
        enrollExpiresAt: number;
      }>('/nodes', { name });
      setAddName('');
      setView({ kind: 'join', name: answer.node.name, token: answer.enrollToken });
      await reload();
    } catch (error) {
      setAddFailure(describeFailure(error));
    } finally {
      setAdding(false);
    }
  };

  if (view.kind === 'join') {
    return (
      <section className="nodes-tab">
        <JoinDialog
          name={view.name}
          serverUrl={(globalThis as { location?: { origin?: string } }).location?.origin ?? ''}
          token={view.token}
          commit={commit}
          onDone={() => {
            setView({ kind: 'list' });
          }}
        />
      </section>
    );
  }

  if (problem !== null && nodes === null) {
    return (
      <div role="alert" className="failure">
        <strong>Could not load nodes</strong>
        <p className="verbatim">{problem}</p>
        <button
          type="button"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (nodes === null) return <p>Loading nodes…</p>;

  const sorted = [...nodes].sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));

  return (
    <section className="nodes-tab">
      <div className="nodes-toolbar">
        <p className="detail">
          {String(nodes.length)} node{nodes.length === 1 ? '' : 's'}
        </p>
        {view.kind === 'list' ? (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setView({ kind: 'adding' });
            }}
          >
            Add node
          </button>
        ) : null}
      </div>

      {view.kind === 'adding' && (
        <div className="config-section node-add-form">
          <label htmlFor="node-add-name">Name</label>
          <input
            id="node-add-name"
            value={addName}
            onChange={(event) => {
              setAddName(event.target.value);
            }}
          />
          {addFailure !== null && (
            <div role="alert" className="failure">
              <strong>{addFailure.title}</strong>
              <p className="verbatim">{addFailure.message}</p>
            </div>
          )}
          <div className="row-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={adding}
              onClick={() => void createNode()}
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              disabled={adding}
              onClick={() => {
                setView({ kind: 'list' });
                setAddFailure(null);
                setAddName('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ul className="node-cards">
        {sorted.map((node) => (
          <NodeRow
            key={node.id}
            client={client}
            node={node}
            libraryNames={libraryNames}
            navigate={props.navigate}
            expanded={expandedId === node.id}
            onToggle={() => {
              setExpandedId((current) => (current === node.id ? null : node.id));
            }}
            onMutated={() => void reload()}
          />
        ))}
      </ul>
    </section>
  );
};
