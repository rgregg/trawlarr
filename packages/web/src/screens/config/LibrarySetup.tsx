import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../../api/client.js';
import {
  describeFailure,
  draftProblems,
  toCreateBody,
  toPlexPatch,
  toRuntimePatch,
  type LibraryDraft,
} from './library-form-model.js';
import type { LibraryRow } from './Libraries.js';

const draftFrom = (library: LibraryRow | null): LibraryDraft => ({
  name: library?.name ?? '',
  // One per line, because a media root is allowed to contain a comma and a
  // textarea is the only field where that is unambiguous.
  roots: (library?.roots ?? []).join('\n'),
  extensions: (library?.extensions ?? []).join(', '),
  allowHardlinked: library?.allowHardlinked ?? false,
  stagingDir: library?.stagingDir ?? '',
  plexUrl: library?.plex?.url ?? '',
  plexToken: library?.plex?.token ?? '',
  plexSectionId: library?.plex?.sectionId ?? '',
  plexPathPrefix: library?.plex?.pathPrefix ?? '',
  runtimeKind: library?.runtime?.kind ?? '',
  runtimeUrl: library?.runtime?.url ?? '',
  runtimeApiKey: '',
  runtimePercent: String(library?.runtime?.percent ?? 5),
  runtimeMinutes: String(library?.runtime?.minutes ?? 3),
});

/**
 * Add or edit a library.
 *
 * THE FORM NEVER REWRITES A REFUSAL. `draftProblems` catches only the two
 * mistakes worth catching before the request is sent; everything else is the
 * daemon's to reject, and its message is rendered exactly as written because
 * those messages name the consequence ("a library with no root has nothing to
 * scan") and a summary would throw the consequence away.
 */
export const LibrarySetup = (props: {
  client: ApiClient;
  /** Null when adding; the existing row when editing. */
  library: LibraryRow | null;
  onSaved: (library: LibraryRow) => void;
  onCancel: () => void;
}): JSX.Element => {
  const [draft, setDraft] = useState<LibraryDraft>(() => draftFrom(props.library));
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [saving, setSaving] = useState(false);
  const problems = draftProblems(draft);
  const existing = props.library;
  const editing = existing !== null;

  const patch = (part: Partial<LibraryDraft>): void => {
    setDraft((current) => ({ ...current, ...part }));
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setFailure(null);
    try {
      const body = toCreateBody(draft);
      // An EDIT SENDS THE SAME BODY, and a blank extensions field therefore
      // omits `extensions` rather than sending `[]`. Omitting it leaves what
      // is stored alone; `[]` would mean "match nothing", which is a silently
      // empty library. The help text below says so, because a field that
      // looks cleared and is not is otherwise a lie.
      const saved =
        existing === null
          ? await props.client.post<LibraryRow>('/libraries', body)
          : await props.client.patch<LibraryRow>(`/libraries/${existing.id}`, {
              ...body,
              plex: toPlexPatch(draft),
              runtime: toRuntimePatch(draft),
            });
      props.onSaved(saved);
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="library-setup" onSubmit={(event) => void submit(event)}>
      <h2>{existing === null ? 'Add a library' : `Edit ${existing.name}`}</h2>

      <label htmlFor="library-name">Name</label>
      <input
        id="library-name"
        value={draft.name}
        onChange={(event) => {
          patch({ name: event.target.value });
        }}
      />

      <label htmlFor="library-roots">Root directories</label>
      <textarea
        id="library-roots"
        rows={3}
        aria-describedby="library-roots-help"
        value={draft.roots}
        onChange={(event) => {
          patch({ roots: event.target.value });
        }}
      />
      <p id="library-roots-help" className="help">
        One absolute path per line, as Trawlarr sees it: under Docker, the path inside the
        container.
      </p>

      <label htmlFor="library-extensions">Extensions</label>
      <input
        id="library-extensions"
        value={draft.extensions}
        aria-describedby="library-extensions-help"
        placeholder="mkv, mp4, avi"
        onChange={(event) => {
          patch({ extensions: event.target.value });
        }}
      />
      <p id="library-extensions-help" className="help">
        Comma-separated. Empty uses the defaults.
      </p>

      <div className="switch">
        <input
          id="library-hardlinked"
          type="checkbox"
          checked={draft.allowHardlinked}
          aria-describedby="library-hardlinked-help"
          onChange={(event) => {
            patch({ allowHardlinked: event.target.checked });
          }}
        />
        <label htmlFor="library-hardlinked">Process hardlinked files</label>
      </div>
      {/* The hardlink caveat, at the point of creation: a library seeded from
          a torrent client looks like nothing is happening, and nothing else
          in the UI would ever say why. */}
      <p id="library-hardlinked-help" className="help">
        Off skips files a torrent client is still seeding, so such a library can show nothing to do.
      </p>

      <label htmlFor="library-staging-dir">Staging directory</label>
      <input
        id="library-staging-dir"
        value={draft.stagingDir}
        aria-describedby="library-staging-dir-help"
        placeholder="Default: <root>/.trawlarr/staging"
        onChange={(event) => {
          patch({ stagingDir: event.target.value });
        }}
      />
      <p id="library-staging-dir-help" className="help">
        Empty stages inside each root. A different filesystem needs <code>allowCrossDevice</code> on
        Replace Original File.
      </p>

      {/* Edit only: the section number has to be read out of Plex, which
          cannot have been done before this library existed. */}
      {editing && (
        <>
          <h3>Plex</h3>

          <label htmlFor="library-plex-url">Plex URL</label>
          <input
            id="library-plex-url"
            value={draft.plexUrl}
            aria-describedby="library-plex-url-help"
            placeholder="http://plex.lan:32400"
            onChange={(event) => {
              patch({ plexUrl: event.target.value });
            }}
          />
          <p id="library-plex-url-help" className="help">
            Empty sends nothing. Plex may already pick up changes on its own.
          </p>

          <label htmlFor="library-plex-token">Plex token</label>
          <input
            id="library-plex-token"
            type="password"
            value={draft.plexToken}
            onChange={(event) => {
              patch({ plexToken: event.target.value });
            }}
          />

          <label htmlFor="library-plex-section">Plex library number</label>
          <input
            id="library-plex-section"
            value={draft.plexSectionId}
            aria-describedby="library-plex-section-help"
            placeholder="2"
            onChange={(event) => {
              patch({ plexSectionId: event.target.value });
            }}
          />
          <p id="library-plex-section-help" className="help">
            From the <code>source=</code> number in Plex&rsquo;s own URL for the library.
          </p>

          <label htmlFor="library-plex-path">Plex library path</label>
          <input
            id="library-plex-path"
            value={draft.plexPathPrefix}
            aria-describedby="library-plex-path-help"
            placeholder="Default: refresh the whole library"
            onChange={(event) => {
              patch({ plexPathPrefix: event.target.value });
            }}
          />
          {/* The one field that fails silently when wrong, so it says so. */}
          <p id="library-plex-path-help" className="help">
            This root as Plex sees it. Wrong here means Plex accepts the refresh and scans nothing.
          </p>
        </>
      )}

      {editing && (
        <>
          <h3>Expected length</h3>

          <label htmlFor="library-runtime-kind">Source</label>
          <select
            id="library-runtime-kind"
            value={draft.runtimeKind}
            onChange={(event) => {
              patch({ runtimeKind: event.target.value as LibraryDraft['runtimeKind'] });
            }}
          >
            <option value="">TMDB only</option>
            <option value="radarr">Radarr</option>
            <option value="sonarr">Sonarr</option>
          </select>

          {draft.runtimeKind !== '' && (
            <>
              <label htmlFor="library-runtime-url">URL</label>
              <input
                id="library-runtime-url"
                value={draft.runtimeUrl}
                placeholder={
                  draft.runtimeKind === 'radarr'
                    ? 'http://radarr.lan:7878'
                    : 'http://sonarr.lan:8989'
                }
                onChange={(event) => {
                  patch({ runtimeUrl: event.target.value });
                }}
              />

              <label htmlFor="library-runtime-key">API key</label>
              <input
                id="library-runtime-key"
                type="password"
                autoComplete="off"
                value={draft.runtimeApiKey}
                placeholder={existing?.runtime?.hasApiKey === true ? 'Saved' : ''}
                onChange={(event) => {
                  patch({ runtimeApiKey: event.target.value });
                }}
              />
            </>
          )}

          <label htmlFor="library-runtime-percent">Tolerance %</label>
          <input
            id="library-runtime-percent"
            inputMode="decimal"
            value={draft.runtimePercent}
            onChange={(event) => {
              patch({ runtimePercent: event.target.value });
            }}
          />

          <label htmlFor="library-runtime-minutes">Tolerance minutes</label>
          <input
            id="library-runtime-minutes"
            inputMode="decimal"
            value={draft.runtimeMinutes}
            aria-describedby="library-runtime-minutes-help"
            onChange={(event) => {
              patch({ runtimeMinutes: event.target.value });
            }}
          />
          <p id="library-runtime-minutes-help" className="help">
            Flagged beyond the larger of the two.
          </p>
        </>
      )}

      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p>{failure.message}</p>
          {failure.retryable && <p className="help">This one is worth trying again.</p>}
        </div>
      )}

      <div className="row-actions">
        <button type="submit" disabled={saving || problems.length > 0}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add library'}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};
