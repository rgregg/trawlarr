import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FlowDefinition } from '@trawlarr/core';
import { ApiClientError, type ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { useNavigationGuard } from '../../shell/useRoute.js';
import { describeFailure } from '../config/library-form-model.js';
import { FlowCanvas } from './FlowCanvas.js';
import type { EditorPlugin, ValidationProblem } from './flow-canvas-model.js';
import { hasUnsavedLayout, layoutStoreFor, saveFlowLayout } from './flow-layout-model.js';
import type { FlowFieldCatalogue } from './plugin-input-model.js';
import {
  editorBuffers,
  hasDefinitionChanges,
  initialEditorBuffer,
  isDraftStale,
  loadPublishLibraries,
  summarizePublish,
  type EditorFlow,
} from './flow-editor-model.js';
import '../../styles/screens/flow-management.css';

interface Validation {
  ok: boolean;
  problems: ValidationProblem[];
  definitionHash: string | null;
}

interface EditorProps {
  client: ApiClient;
  id: string;
  navigate: (to: string) => void;
}

/**
 * Renaming, in place in the editor's title.
 *
 * A separate request from publishing (`PATCH` rather than `PUT`) because a
 * name is not part of the definition: it is outside the signature hash, so
 * fixing a typo must not create a flow version or re-queue a library.
 */
function FlowTitle({
  name,
  disabled,
  onRename,
}: {
  name: string;
  disabled: boolean;
  onRename: (name: string) => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(name);
  }, [name]);
  if (!editing) {
    return (
      <div className="editor-title">
        <h1 title={name}>{name}</h1>
        <button type="button" disabled={disabled} onClick={() => setEditing(true)}>
          Rename
        </button>
      </div>
    );
  }
  return (
    <form
      className="editor-title"
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        if (next === '' || next === name) {
          setEditing(false);
          setDraft(name);
          return;
        }
        setBusy(true);
        void onRename(next).then(
          () => {
            setBusy(false);
            setEditing(false);
          },
          () => {
            // The failure itself is reported by the page; keep the field open
            // with what was typed so a duplicate name can be corrected.
            setBusy(false);
          },
        );
      }}
    >
      <label htmlFor="flow-name">Flow name</label>
      <input
        id="flow-name"
        value={draft}
        autoFocus
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit" className="btn-primary" disabled={busy || draft.trim() === ''}>
        {busy ? 'Saving…' : 'Save name'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setDraft(name);
          setEditing(false);
        }}
      >
        Cancel
      </button>
    </form>
  );
}

/**
 * The publish confirmation, as a modal.
 *
 * It used to be a panel above the canvas, which on a laptop pushed the canvas
 * and its controls off screen exactly when an operator wanted to look at the
 * graph they were about to publish. A modal takes focus, states the
 * consequence, and gives the page back unchanged when dismissed.
 */
function PublishDialog({
  preview,
  fromHash,
  toHash,
  note,
  busy,
  canPublish,
  onNote,
  onPublish,
  onCancel,
}: {
  preview: NonNullable<ReturnType<typeof summarizePublish>>;
  fromHash: string | null;
  toHash: string | null;
  note: string;
  busy: boolean;
  canPublish: boolean;
  onNote: (note: string) => void;
  onPublish: () => void;
  onCancel: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      className="editor-publish-dialog"
      ref={dialog}
      aria-labelledby="publish-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <section className="editor-publish">
        <h2 id="publish-heading">Publish this flow?</h2>
        <p>
          {preview.unchanged
            ? 'The definition is unchanged. Publishing records a version but does not invalidate any file signatures.'
            : `${String(preview.eligible)} non-terminal file(s) across ${String(preview.libraries.length)} libraries are eligible for re-evaluation. Publishing requests a rescan; how many files will actually re-encode is not known.`}
        </p>
        {preview.terminal > 0 && (
          <p>
            {String(preview.terminal)} failed, not-converging, or held-for-review file(s) are
            excluded and need manual requeue.
          </p>
        )}
        {preview.libraries.length === 0 && <p>No library currently uses this flow.</p>}
        <ul>
          {preview.libraries.map((library) => (
            <li key={library.id}>
              {library.name}: {String(library.total)} non-missing file(s)
            </li>
          ))}
        </ul>
        <p className="editor-hash">
          Hash: <code>{fromHash}</code> to <code>{toHash}</code>
        </p>
        <label className="editor-note">
          Version note (optional)
          <input value={note} disabled={busy} onChange={(event) => onNote(event.target.value)} />
        </label>
        <div className="row-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !canPublish}
            onClick={onPublish}
          >
            {busy ? 'Publishing...' : 'Confirm publish'}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </dialog>
  );
}

const Editor = (
  props: EditorProps & {
    initial: EditorFlow;
    plugins: EditorPlugin[];
    fields: FlowFieldCatalogue | null;
  },
): JSX.Element => {
  const { client, id } = props;
  const [initial] = useState(() => initialEditorBuffer(props.initial, editorBuffers.get(id)));
  const [layoutStore] = useState(() => layoutStoreFor(id, props.initial.layout, client));
  const layoutState = useSyncExternalStore(layoutStore.subscribe, layoutStore.getSnapshot);
  useEffect(() => {
    layoutStore.setSave((layout) => saveFlowLayout(client, id, layout));
  }, [client, id, layoutStore]);
  const [flow, setFlow] = useState(props.initial);
  const [definition, setDefinition] = useState(initial.definition);
  const [saved, setSaved] = useState(props.initial.draft ?? props.initial.definition);
  const [baseHash, setBaseHash] = useState(initial.baseHash);
  const [liveHash, setLiveHash] = useState(props.initial.definitionHash);
  const [validation, setValidation] = useState<{ key: string; result: Validation } | null>(null);
  const [validationFailure, setValidationFailure] = useState<string | null>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(() =>
    editorBuffers.has(id)
      ? 'Recovered unsaved changes from this tab. Save draft to keep them on the daemon.'
      : null,
  );
  const [preview, setPreview] = useState<ReturnType<typeof summarizePublish> | null>(null);
  const [note, setNote] = useState('');
  const [canvasKey, setCanvasKey] = useState(0);
  const key = JSON.stringify(definition);
  const dirty = hasDefinitionChanges(definition, saved);
  const stale = isDraftStale(baseHash, liveHash);
  const validated = validation?.key === key && validationFailure === null;
  const hash = validated ? validation.result.definitionHash : null;
  const valid = validated && validation.result.ok && typeof hash === 'string';
  useNavigationGuard(dirty || busy || hasUnsavedLayout(layoutState));

  useEffect(() => {
    let cancelled = false;
    setValidationFailure(null);
    const timer = window.setTimeout(() => {
      void client.post<Validation>('/flows/validate', { definition }).then(
        (result) => {
          if (!cancelled) setValidation({ key, result });
        },
        (error: unknown) => {
          if (!cancelled) setValidationFailure(describeFailure(error).message);
        },
      );
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, definition, key, validationAttempt]);

  const change = (next: FlowDefinition): void => {
    if (hasDefinitionChanges(next, saved)) editorBuffers.set(id, { definition: next, baseHash });
    else editorBuffers.delete(id);
    setDefinition(next);
    setPreview(null);
    setMessage(null);
  };

  const report = (error: unknown): void => {
    setFailure(describeFailure(error));
    if (error instanceof ApiClientError && error.code === 'flow-changed') {
      setPreview(null);
    }
  };

  const rename = async (name: string): Promise<void> => {
    setFailure(null);
    try {
      const next = await client.patch<EditorFlow>(`/flows/${id}`, { name });
      // Only the name: the definition being edited is this tab's business,
      // and a rename must not reach in and replace an unsaved graph.
      setFlow((current) => ({ ...current, name: next.name }));
      setMessage(`Renamed to “${next.name}”. The flow definition is unchanged.`);
    } catch (error) {
      report(error);
      throw error;
    }
  };

  const storeDraft = async (): Promise<void> => {
    const result = await client.put<{ flow: EditorFlow } & Validation>(`/flows/${id}/draft`, {
      definition,
      baseHash,
    });
    setFlow(result.flow);
    setLiveHash(result.flow.definitionHash);
    setSaved(definition);
    editorBuffers.delete(id);
    setValidation({ key, result });
    setMessage(
      result.ok
        ? 'Draft saved. The published flow is unchanged.'
        : 'Draft saved with validation problems. It is not running.',
    );
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await storeDraft();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  const review = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setPreview(null);
    try {
      // Preserve the draft first: even a later publication/network failure
      // must not cost the graph the user just built.
      await storeDraft();
      const [current, libraries] = await Promise.all([
        client.get<EditorFlow>(`/flows/${id}`),
        loadPublishLibraries(client, id),
      ]);
      setLiveHash(current.definitionHash);
      if (isDraftStale(baseHash, current.definitionHash)) {
        throw new ApiClientError({
          status: 409,
          code: 'flow-changed',
          message:
            'The published flow changed since this draft began. Your draft is preserved; discard it to start from the current published flow.',
        });
      }
      setPreview(summarizePublish(libraries, hash === current.definitionHash));
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  const publish = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const next = await client.put<EditorFlow>(`/flows/${id}`, { definition, baseHash, note });
      setFlow(next);
      setDefinition(next.definition);
      setSaved(next.definition);
      editorBuffers.delete(id);
      setBaseHash(next.definitionHash);
      setLiveHash(next.definitionHash);
      setPreview(null);
      setNote('');
      setMessage(
        'Published. This version is now live; affected libraries have been scheduled for a rescan.',
      );
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  const discard = async (): Promise<void> => {
    if (
      !window.confirm(
        'Discard this draft and any unsaved changes? The current published flow will be loaded.',
      )
    )
      return;
    setBusy(true);
    setFailure(null);
    try {
      await client.del(`/flows/${id}/draft`);
      const next = await client.get<EditorFlow>(`/flows/${id}`);
      setFlow(next);
      setDefinition(next.definition);
      setSaved(next.definition);
      editorBuffers.delete(id);
      setBaseHash(next.definitionHash);
      setLiveHash(next.definitionHash);
      setPreview(null);
      setCanvasKey((value) => value + 1);
      setMessage('Draft discarded. Showing the current published flow.');
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flow-editor-page" aria-busy={busy}>
      {/*
       * One command bar, and it never scrolls away: the page itself does not
       * scroll (the canvas pans instead), so Save draft and Review & publish
       * stay reachable no matter where the graph has been dragged to.
       */}
      <div className="editor-toolbar">
        <Link to={`/flows/${id}`} navigate={props.navigate}>
          ← Flow and history
        </Link>
        <FlowTitle name={flow.name} disabled={busy} onRename={rename} />
        <span role="status" className="badge">
          {dirty ? 'Unsaved changes' : flow.draft !== null ? 'Draft saved' : 'No unpublished draft'}
        </span>
        <span className={`badge${validated && !valid ? ' badge-bad' : ''}`}>
          {validationFailure !== null
            ? 'Validation unavailable'
            : !validated
              ? 'Validating...'
              : valid
                ? 'Valid flow'
                : 'Draft invalid'}
        </span>
        <span role="status" className={`badge${layoutState.error !== null ? ' badge-bad' : ''}`}>
          {layoutState.error !== null
            ? 'Layout not saved'
            : layoutState.saving
              ? 'Saving layout...'
              : 'Layout up to date'}
        </span>
        <div className="row-actions">
          <button
            type="button"
            disabled={busy || (!dirty && flow.draft === null)}
            onClick={() => void save()}
          >
            Save draft
          </button>
          <button
            type="button"
            disabled={busy || (!dirty && flow.draft === null)}
            onClick={() => void discard()}
          >
            Discard draft
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !valid || stale || hash === liveHash}
            title={
              hash === liveHash
                ? 'Only graph or parameter changes create a new flow version.'
                : undefined
            }
            onClick={() => void review()}
          >
            Review &amp; publish
          </button>
        </div>
      </div>
      <div className="editor-messages">
        {layoutState.error !== null && (
          <div role="alert" className="failure">
            <strong>Could not save the layout</strong>
            <p>
              {layoutState.error} Your positions are still in this tab. The flow definition is
              unchanged by layout saves.
            </p>
            <button type="button" onClick={layoutStore.retry}>
              Retry layout save
            </button>
          </div>
        )}
        {message !== null && (
          <p role="status" className="detail">
            {message}
          </p>
        )}
        {stale && (
          <p role="alert" className="failure">
            This draft is based on an older published version. Publishing is blocked to avoid
            overwriting another change. Your draft can still be saved; discard it to load the latest
            published flow.
          </p>
        )}
        {failure !== null && (
          <div role="alert" className="failure">
            <strong>{failure.title}</strong>
            <p>{failure.message}</p>
          </div>
        )}
        {validationFailure !== null && (
          <div role="alert" className="failure">
            <p>
              Could not validate with the daemon: {validationFailure}. You can still save a draft,
              but cannot publish until validation succeeds.
            </p>
            <button type="button" onClick={() => setValidationAttempt((value) => value + 1)}>
              Retry validation
            </button>
          </div>
        )}
      </div>
      {preview !== null && (
        <PublishDialog
          preview={preview}
          fromHash={liveHash}
          toHash={hash}
          note={note}
          busy={busy}
          canPublish={valid && !stale}
          onNote={setNote}
          onPublish={() => void publish()}
          onCancel={() => setPreview(null)}
        />
      )}
      <FlowCanvas
        key={canvasKey}
        definition={definition}
        plugins={props.plugins}
        fields={props.fields}
        problems={validated ? validation.result.problems : []}
        onChange={change}
        initialLayout={layoutState.layout}
        onLayoutChange={layoutStore.setLayout}
        disabled={busy || preview !== null}
      />
    </section>
  );
};

export const FlowEditor = (props: EditorProps): JSX.Element => {
  const [loaded, setLoaded] = useState<{
    flow: EditorFlow;
    plugins: EditorPlugin[];
    fields: FlowFieldCatalogue | null;
  } | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailure(null);
    void Promise.all([
      props.client.get<EditorFlow>(`/flows/${props.id}`),
      props.client.get<EditorPlugin[]>('/plugins'),
      // The property catalogue is a convenience, not a prerequisite: a daemon
      // too old to serve it must still open its own editor, with the
      // insertion helper simply absent.
      props.client.get<FlowFieldCatalogue>('/flows/fields').catch(() => null),
    ]).then(
      ([flow, plugins, fields]) => {
        if (!cancelled) setLoaded({ flow, plugins, fields });
      },
      (error: unknown) => {
        if (!cancelled) setFailure(describeFailure(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.client, props.id, attempt]);
  if (loaded !== null) {
    return (
      <Editor {...props} initial={loaded.flow} plugins={loaded.plugins} fields={loaded.fields} />
    );
  }
  return (
    <section className="flow-editor-page">
      <Link to="/config?tab=flows" navigate={props.navigate}>
        Back to flows
      </Link>
      {failure === null ? (
        <p aria-busy="true">Loading flow and components...</p>
      ) : (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p>{failure.message}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
};
