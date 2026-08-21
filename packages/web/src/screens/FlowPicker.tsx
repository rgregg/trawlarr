import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { describeFailure } from './library-form-model.js';
import type { LibraryRow } from './Libraries.js';

interface FlowResource {
  id: string;
  name: string;
  description: string | null;
  definitionHash: string;
}

interface TemplateParameter {
  name: string;
  label: string;
  defaultValue: string;
  options?: string[];
  tooltip: string;
}

interface FlowTemplateResource {
  id: string;
  name: string;
  description: string;
  parameters: TemplateParameter[];
}

const defaultsOf = (template: FlowTemplateResource): Record<string, string> =>
  Object.fromEntries(
    template.parameters.map((parameter) => [parameter.name, parameter.defaultValue]),
  );

/**
 * Attach a flow to a library: pick one that exists, or build one from a
 * template.
 *
 * TEMPLATE TOOLTIPS ARE RENDERED, not summarised. They are the only place
 * this product explains that "Audio language to guarantee" ADDS a track
 * rather than converting one, or that a hardware encoder that is not present
 * fails every job rather than falling back to software. A form that dropped
 * them would be a form that silently invites those two mistakes.
 *
 * A refusal from `POST /flows` is rendered WHOLE. The validator lists every
 * problem and each message names the consequence — "the executor indexes
 * nodes by id, so all but one is silently dropped and the flow that runs is
 * not the flow you wrote" — and "invalid flow" says none of that.
 */
export const FlowPicker = (props: {
  client: ApiClient;
  library: LibraryRow;
  onAttached: (library: LibraryRow) => void;
  onCancel: () => void;
}): JSX.Element => {
  const [flows, setFlows] = useState<FlowResource[] | null>(null);
  const [templates, setTemplates] = useState<FlowTemplateResource[] | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [busy, setBusy] = useState(false);

  const [chosenFlowId, setChosenFlowId] = useState<string | null>(props.library.flowId);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [flowName, setFlowName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  const { client } = props;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [existing, available] = await Promise.all([
          client.get<FlowResource[]>('/flows'),
          client.get<FlowTemplateResource[]>('/flows/templates'),
        ]);
        if (cancelled) return;
        setFlows(existing);
        setTemplates(available);
      } catch (error) {
        if (!cancelled) setFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const template = templates?.find((candidate) => candidate.id === templateId) ?? null;

  const chooseTemplate = (next: FlowTemplateResource | null): void => {
    setTemplateId(next?.id ?? null);
    setValues(next === null ? {} : defaultsOf(next));
    if (next !== null && flowName === '') setFlowName(`${props.library.name} — ${next.name}`);
  };

  const attach = async (flowId: string): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const saved = await props.client.patch<LibraryRow>(`/libraries/${props.library.id}`, {
        flowId,
      });
      props.onAttached(saved);
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const createAndAttach = async (): Promise<void> => {
    if (template === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const flow = await props.client.post<FlowResource>('/flows', {
        name: flowName,
        templateId: template.id,
        templateValues: values,
      });
      // Two calls, in this order, and the second only if the first stored
      // something: attaching a flow id the daemon refused to store would be
      // a 404 explaining nothing.
      const saved = await props.client.patch<LibraryRow>(`/libraries/${props.library.id}`, {
        flowId: flow.id,
      });
      props.onAttached(saved);
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flow-picker">
      <h2>Flow for {props.library.name}</h2>
      <p className="help">
        Attaching a flow changes what &ldquo;converged&rdquo; means for every file in this library,
        so trawlarr will rescan it.
      </p>

      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          {/* Whitespace preserved: the validator lists every problem in one
              message and each sentence is a separate diagnosis. */}
          <p className="verbatim">{failure.message}</p>
        </div>
      )}

      <h3>Flows you already have</h3>
      {flows === null ? (
        <p>Loading flows…</p>
      ) : flows.length === 0 ? (
        <p>None yet. Build one from a template below.</p>
      ) : (
        <ul className="flow-list">
          {flows.map((flow) => (
            <li key={flow.id}>
              <label>
                <input
                  type="radio"
                  name="flow"
                  checked={chosenFlowId === flow.id}
                  onChange={() => {
                    setChosenFlowId(flow.id);
                  }}
                />{' '}
                <strong>{flow.name}</strong>
                {props.library.flowId === flow.id && <span className="badge"> attached</span>}
              </label>
              {flow.description !== null && <p className="help">{flow.description}</p>}
            </li>
          ))}
        </ul>
      )}
      {flows !== null && flows.length > 0 && (
        <button
          type="button"
          disabled={busy || chosenFlowId === null || chosenFlowId === props.library.flowId}
          onClick={() => {
            if (chosenFlowId !== null) void attach(chosenFlowId);
          }}
        >
          {busy ? 'Attaching…' : 'Attach this flow'}
        </button>
      )}

      <h3>Create one from a template</h3>
      {templates === null ? (
        <p>Loading templates…</p>
      ) : (
        <>
          <label htmlFor="template">Template</label>
          <select
            id="template"
            value={templateId ?? ''}
            onChange={(event) => {
              chooseTemplate(
                templates.find((candidate) => candidate.id === event.target.value) ?? null,
              );
            }}
          >
            <option value="">Choose a template…</option>
            {templates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          {template !== null && (
            <div className="template-form">
              <p className="help">{template.description}</p>

              <label htmlFor="flow-name">Name for this flow</label>
              <input
                id="flow-name"
                value={flowName}
                onChange={(event) => {
                  setFlowName(event.target.value);
                }}
              />

              {template.parameters.map((parameter) => {
                const inputId = `param-${parameter.name}`;
                const helpId = `${inputId}-help`;
                const value = values[parameter.name] ?? parameter.defaultValue;
                return (
                  <div key={parameter.name} className="parameter">
                    <label htmlFor={inputId}>{parameter.label}</label>
                    {parameter.options === undefined ? (
                      <input
                        id={inputId}
                        aria-describedby={helpId}
                        value={value}
                        onChange={(event) => {
                          setValues((current) => ({
                            ...current,
                            [parameter.name]: event.target.value,
                          }));
                        }}
                      />
                    ) : (
                      <select
                        id={inputId}
                        aria-describedby={helpId}
                        value={value}
                        onChange={(event) => {
                          setValues((current) => ({
                            ...current,
                            [parameter.name]: event.target.value,
                          }));
                        }}
                      >
                        {parameter.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    )}
                    {/* Always visible, never a hover tooltip: this is the
                        documentation for the setting, and a keyboard or
                        touch user gets no hover. */}
                    <p id={helpId} className="help">
                      {parameter.tooltip}
                    </p>
                  </div>
                );
              })}

              <button
                type="button"
                disabled={busy || flowName.trim() === ''}
                onClick={() => void createAndAttach()}
              >
                {busy ? 'Creating…' : 'Create and attach'}
              </button>
            </div>
          )}
        </>
      )}

      <div className="row-actions">
        <button type="button" onClick={props.onCancel}>
          Back to libraries
        </button>
      </div>
    </section>
  );
};
