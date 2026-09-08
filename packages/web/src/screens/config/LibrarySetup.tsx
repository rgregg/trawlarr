import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../../api/client.js';
import {
  describeFailure,
  draftProblems,
  toCreateBody,
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
          : await props.client.patch<LibraryRow>(`/libraries/${existing.id}`, body);
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
        One per line, absolute, <strong>as the trawlarr process sees them</strong>. In Docker that
        is the path inside the container (<code>/library/movies</code>), not the path on the host.
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
        Comma-separated. Leave it empty to keep trawlarr&rsquo;s own list — an empty list is never
        sent, because &ldquo;match nothing&rdquo; scans as a permanently empty library with no error
        to explain it.
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
        Files hardlinked into a torrent client&rsquo;s download directory are skipped by default.
        Replacing one either breaks the link or mutates a copy that is still seeding. If your
        library was seeded by a torrent client and trawlarr reports nothing to do, this is why.
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
        Optional absolute path. Leave empty to stage inside each root&rsquo;s{' '}
        <code>.trawlarr/staging</code> directory, enabling instant atomic renames on completion.
        Pointing to a separate filesystem (such as a local SSD cache in front of an NFS library)
        requires <code>allowCrossDevice</code> on Replace Original File in your flow, falling back
        to copy-then-atomic-rename.
      </p>

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
