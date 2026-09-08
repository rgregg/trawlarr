import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { describeFailure } from '../config/library-form-model.js';
import type { EditorPlugin } from './flow-canvas-model.js';
import type { EditorFlow, FlowLibrary } from './flow-editor-model.js';
import '../../styles/screens/flow-management.css';

export const Flows = (props: {
  client: ApiClient;
  navigate: (to: string) => void;
}): JSX.Element => {
  const [data, setData] = useState<{
    flows: EditorFlow[];
    libraries: FlowLibrary[];
    plugins: EditorPlugin[];
  } | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    let cancelled = false;
    setFailure(null);
    void Promise.all([
      props.client.get<EditorFlow[]>('/flows'),
      props.client.get<FlowLibrary[]>('/libraries'),
      props.client.get<EditorPlugin[]>('/plugins'),
    ]).then(
      ([flows, libraries, plugins]) => {
        if (!cancelled) setData({ flows, libraries, plugins });
      },
      (error: unknown) => {
        if (!cancelled) setFailure(describeFailure(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.client, attempt]);

  const start = data?.plugins.find(
    (plugin) => plugin.enabled && plugin.isStartPlugin && plugin.source === 'first-party',
  );
  const create = async (): Promise<void> => {
    if (start === undefined) {
      setFailure({
        title: 'Cannot create flow',
        message: 'No enabled first-party Start component is available.',
        retryable: false,
      });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const next = await props.client.post<EditorFlow>('/flows', {
        name: name.trim(),
        definition: {
          nodes: [
            {
              id: 'start',
              pluginId: start.id,
              pluginVersion: start.version,
              inputs: Object.fromEntries(
                start.details.inputs.map((input) => [input.name, input.defaultValue]),
              ),
            },
          ],
          edges: [],
        },
      });
      props.navigate(`/flows/${next.id}/edit`);
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await props.client.del(`/flows/${id}`);
      setRemoving(null);
      setAttempt((value) => value + 1);
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  };
  const flows = data?.flows.filter((flow) =>
    `${flow.name} ${flow.description ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="flows-list">
      <div className="flows-list-heading">
        <div>
          <h2>Flows</h2>
          <p className="help">
            Build and publish processing flows, independently of the libraries that use them.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || data === null}
          onClick={() => setCreating(true)}
        >
          New flow
        </button>
      </div>
      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p>{failure.message}</p>
          <button type="button" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>
            Refresh list
          </button>
        </div>
      )}
      {creating && (
        <form
          className="flow-create"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <h3>Create a flow</h3>
          <label>
            Flow name
            <input
              value={name}
              autoFocus
              required
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <p className="help">
            Creates an unattached flow with a Start element, then opens the editor. No library is
            changed.
          </p>
          <div className="row-actions">
            <button type="submit" className="btn-primary" disabled={busy || name.trim() === ''}>
              Create &amp; edit
            </button>
            <button type="button" disabled={busy} onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {data === null && failure === null && <p aria-busy="true">Loading flows...</p>}
      {data !== null && (
        <>
          <label className="flow-search">
            Find a flow
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search names and descriptions"
            />
          </label>
          {data.flows.length === 0 ? (
            <p>No flows yet. Create one to start building.</p>
          ) : flows?.length === 0 ? (
            <p>No flows match your search.</p>
          ) : (
            <ul className="flow-cards">
              {flows?.map((flow) => {
                const libraries = data.libraries.filter((library) => library.flowId === flow.id);
                return (
                  <li className="flow-card" key={flow.id}>
                    <div className="flow-card-title">
                      <h3>
                        <Link to={`/flows/${flow.id}`} navigate={props.navigate}>
                          {flow.name}
                        </Link>
                      </h3>
                      {flow.draft !== null && <span className="badge">Unpublished draft</span>}
                    </div>
                    {flow.description && <p>{flow.description}</p>}
                    <p className="help">
                      {String(flow.definition.nodes.length)} nodes / Published hash{' '}
                      <code>{flow.definitionHash.slice(0, 8)}</code>
                    </p>
                    <p>
                      Libraries:{' '}
                      {libraries.length === 0
                        ? 'Not attached'
                        : libraries.map((library) => library.name).join(', ')}
                    </p>
                    <div className="row-actions">
                      <Link
                        className="button btn-primary"
                        to={`/flows/${flow.id}/edit`}
                        navigate={props.navigate}
                      >
                        Edit flow
                      </Link>
                      <Link className="button" to={`/flows/${flow.id}`} navigate={props.navigate}>
                        View &amp; history
                      </Link>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={busy}
                        onClick={() => setRemoving(flow.id)}
                      >
                        Delete
                      </button>
                    </div>
                    {removing === flow.id && (
                      <div role="alert" className="failure">
                        <strong>Delete {flow.name} and its draft?</strong>
                        <p>
                          {libraries.length === 0
                            ? 'No library uses this flow.'
                            : `This detaches ${libraries.map((library) => library.name).join(', ')}. Those libraries will need another flow before processing can continue.`}{' '}
                          This cannot be undone.
                        </p>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn-danger"
                            disabled={busy}
                            onClick={() => void remove(flow.id)}
                          >
                            Confirm delete
                          </button>
                          <button type="button" disabled={busy} onClick={() => setRemoving(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
};
