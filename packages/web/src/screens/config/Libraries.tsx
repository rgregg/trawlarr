import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import type { LiveState } from '../../api/events.js';
import { Link } from '../../shell/Link.js';
import { formatRoute } from '../../shell/route.js';
import type { LibraryResource } from '../overview-model.js';
import { FlowPicker } from './FlowPicker.js';
import { describeFailure } from './library-form-model.js';
import { LibrarySetup } from './LibrarySetup.js';

/**
 * A library as this screen reads it: the fields Overview already declares,
 * plus the two only the form needs. A structural subset, so a field added to
 * the resource never breaks these types.
 */
export interface LibraryRow extends LibraryResource {
  extensions: string[];
  allowHardlinked: boolean;
}

type View =
  | { kind: 'list' }
  | { kind: 'setup'; library: LibraryRow | null }
  | { kind: 'flow'; library: LibraryRow };

const Row = (props: {
  client: ApiClient;
  library: LibraryRow;
  live: LiveState;
  navigate: (to: string) => void;
  onEdit: () => void;
  onFlow: () => void;
  onChanged: (library: LibraryRow) => void;
}): JSX.Element => {
  const { library } = props;
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (call: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      await call();
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const scanning = props.live.scanning[library.id];

  return (
    <li className={`card status-${library.paused ? 'paused' : 'idle'}`}>
      <h3>{library.name}</h3>
      <p className="detail">{library.roots.join(', ')}</p>
      {/* Status as TEXT, not only as an edge colour. */}
      <p className="badge">{library.paused ? 'paused' : 'running'}</p>

      {library.paused && (
        // The daemon's own words. When a flow names a plugin that is not
        // installed, THIS SENTENCE IS THE ONLY PLACE THE PLUGIN ID APPEARS —
        // and the pause clears itself as soon as that plugin comes back, so
        // the operator needs to read it rather than be told "paused".
        <p className="pause-reason">
          {library.pausedExplanation ?? library.pausedReason ?? 'Paused, with no reason recorded.'}
        </p>
      )}

      {library.flowId === null ? (
        <p className="detail">
          No flow attached, so nothing in this library can converge. Attach one below.
        </p>
      ) : (
        <p className="detail">
          Flow{' '}
          <Link to={formatRoute({ name: 'flow', id: library.flowId })} navigate={props.navigate}>
            {library.flowId}
          </Link>
        </p>
      )}

      {scanning !== undefined && <p className="detail">Scanning — {String(scanning)} files seen</p>}

      <div className="row-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const answer = await props.client.post<{ note: string }>(
                `/libraries/${library.id}/scan`,
                {},
              );
              // 202: the scan was QUEUED, not performed. Saying so is the
              // difference between a button that looks broken and one that
              // explains where the answer will appear.
              setNote(answer.note);
            })
          }
        >
          Scan
        </button>
        {library.paused && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const resumed = await props.client.post<LibraryRow>(
                  `/libraries/${library.id}/resume`,
                  {},
                );
                props.onChanged(resumed);
              })
            }
          >
            Resume
          </button>
        )}
        <button type="button" onClick={props.onEdit}>
          Edit
        </button>
        <button type="button" onClick={props.onFlow}>
          {library.flowId === null ? 'Attach a flow' : 'Change flow'}
        </button>
      </div>

      {note !== null && <p className="detail">{note}</p>}
      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          {/* VERBATIM. A refused resume is a 409 whose body names the missing
              plugin and says the pause clears itself when it returns; that is
              the whole diagnosis and it is not summarisable. */}
          <p className="verbatim">{failure.message}</p>
        </div>
      )}
    </li>
  );
};

/**
 * The libraries screen: the list, and the two forms it leads to.
 *
 * Adding a library lands on the FLOW STEP rather than back on the list,
 * because a library with no flow converges nothing — the daemon says so in
 * its pause reason the moment it is created, and dropping the operator back
 * on a list of one paused library would be an odd way to explain that.
 */
export const Libraries = (props: {
  client: ApiClient;
  live: LiveState;
  navigate: (to: string) => void;
}): JSX.Element => {
  const [libraries, setLibraries] = useState<LibraryRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const { client } = props;
  const stale = props.live.staleness.libraries;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<LibraryRow[]>('/libraries');
        if (cancelled) return;
        setProblem(null);
        setLibraries(next);
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetched when the socket says a library changed — a pause, a resume,
    // a finished scan — and never on a timer.
  }, [client, stale, view]);

  const replace = (library: LibraryRow): void => {
    setLibraries((current) =>
      (current ?? []).map((candidate) => (candidate.id === library.id ? library : candidate)),
    );
  };

  if (view.kind === 'setup') {
    return (
      <LibrarySetup
        client={client}
        library={view.library}
        onSaved={(library) => {
          replace(library);
          setView({ kind: 'flow', library });
        }}
        onCancel={() => {
          setView({ kind: 'list' });
        }}
      />
    );
  }

  if (view.kind === 'flow') {
    return (
      <FlowPicker
        client={client}
        library={view.library}
        onAttached={(library) => {
          replace(library);
          setView({ kind: 'list' });
        }}
        onCancel={() => {
          setView({ kind: 'list' });
        }}
      />
    );
  }

  return (
    <section className="libraries">
      <div className="row-actions">
        <button
          type="button"
          onClick={() => {
            setView({ kind: 'setup', library: null });
          }}
        >
          Add a library
        </button>
      </div>
      {problem !== null && <p role="alert">{problem}</p>}
      {libraries === null ? (
        <p>Loading libraries…</p>
      ) : libraries.length === 0 ? (
        <p>No libraries yet. Add one to start converging something.</p>
      ) : (
        <ul className="library-cards">
          {libraries.map((library) => (
            <Row
              key={library.id}
              client={client}
              library={library}
              live={props.live}
              navigate={props.navigate}
              onEdit={() => {
                setView({ kind: 'setup', library });
              }}
              onFlow={() => {
                setView({ kind: 'flow', library });
              }}
              onChanged={replace}
            />
          ))}
        </ul>
      )}
    </section>
  );
};
