import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FlowDefinition } from '@trawlarr/core';
import { ApiClientError, type ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { PageHeader } from '../../shell/PageHeader.js';
import { useNavigationGuard } from '../../shell/useRoute.js';
import { describeFailure } from '../config/library-form-model.js';
import { FlowCanvas } from './FlowCanvas.js';
import type { EditorPlugin, ValidationProblem } from './flow-canvas-model.js';
import { hasUnsavedLayout, layoutStoreFor, saveFlowLayout } from './flow-layout-model.js';
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

const Editor = (
  props: EditorProps & { initial: EditorFlow; plugins: EditorPlugin[] },
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
      <Link to={`/flows/${id}`} navigate={props.navigate}>
        Back to flow and history
      </Link>
      <PageHeader
        title={flow.name}
        subtitle="Flow editor - Draft changes do not affect the running flow."
      />
      <div className="editor-toolbar">
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
      </div>
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
            Could not validate with the daemon: {validationFailure}. You can still save a draft, but
            cannot publish until validation succeeds.
          </p>
          <button type="button" onClick={() => setValidationAttempt((value) => value + 1)}>
            Retry validation
          </button>
        </div>
      )}
      {preview !== null && (
        <section className="editor-publish" aria-labelledby="publish-heading">
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
            Hash: <code>{liveHash}</code> to <code>{hash}</code>
          </p>
          <label className="editor-note">
            Version note (optional)
            <input value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div className="row-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !valid || stale}
              onClick={() => void publish()}
            >
              {busy ? 'Publishing...' : 'Confirm publish'}
            </button>
            <button type="button" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      <FlowCanvas
        key={canvasKey}
        definition={definition}
        plugins={props.plugins}
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
  const [loaded, setLoaded] = useState<{ flow: EditorFlow; plugins: EditorPlugin[] } | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailure(null);
    void Promise.all([
      props.client.get<EditorFlow>(`/flows/${props.id}`),
      props.client.get<EditorPlugin[]>('/plugins'),
    ]).then(
      ([flow, plugins]) => {
        if (!cancelled) setLoaded({ flow, plugins });
      },
      (error: unknown) => {
        if (!cancelled) setFailure(describeFailure(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.client, props.id, attempt]);
  if (loaded !== null) return <Editor {...props} initial={loaded.flow} plugins={loaded.plugins} />;
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
