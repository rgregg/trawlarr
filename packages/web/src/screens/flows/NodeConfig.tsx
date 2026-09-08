import { useEffect, useId, useRef, useState } from 'react';
import type { FlowNode } from '@trawlarr/core';
import type { PluginInput } from '@trawlarr/plugin-api';
import { useNavigationGuard } from '../../shell/useRoute.js';
import type { EditorPlugin } from './flow-canvas-model.js';
import {
  effectiveInputs,
  inputText,
  isInputVisible,
  parseInputObject,
  pluginInputBufferKey,
  recoverPluginInputBuffer,
  updatePluginInput,
} from './plugin-input-model.js';
import type { PluginInputBuffer } from './plugin-input-model.js';

// A 401 can unmount the entire auth tree without navigation. Keep unapplied
// configuration in this tab's memory, never browser storage or a server draft.
const inputBuffers = new Map<string, PluginInputBuffer>();

interface Props {
  node: FlowNode;
  plugin?: EditorPlugin;
  disabled?: boolean;
  onSave: (node: FlowNode) => void;
  onClose: () => void;
}

function InputField({
  field,
  value,
  id,
  onChange,
}: {
  field: PluginInput;
  value: unknown;
  id: string;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const common = { id, 'aria-describedby': `${id}-help`, name: field.name };
  const text = inputText(value);
  switch (field.inputUI.type) {
    case 'dropdown': {
      const options = field.inputUI.options ?? [];
      return (
        <select {...common} value={text} onChange={(event) => onChange(event.target.value)}>
          {!options.includes(text) && <option value={text}>{text || '(empty)'}</option>}
          {options.map((option) => (
            <option value={option} key={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    case 'switch':
      return (
        <input
          {...common}
          type="checkbox"
          role="switch"
          checked={value === true || value === 'true'}
          onChange={(event) =>
            onChange(field.type === 'string' ? String(event.target.checked) : event.target.checked)
          }
        />
      );
    case 'slider':
      return (
        <div className="flow-config-slider">
          <input
            {...common}
            type="range"
            min={field.inputUI.sliderOptions?.min ?? 0}
            max={field.inputUI.sliderOptions?.max ?? 100}
            step="any"
            value={text}
            onChange={(event) => onChange(event.target.value)}
          />
          <input
            aria-label={`${field.label} exact value`}
            type="number"
            step="any"
            min={field.inputUI.sliderOptions?.min}
            max={field.inputUI.sliderOptions?.max}
            value={text}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      );
    case 'textarea':
    case 'codeEditor':
      return (
        <textarea
          {...common}
          className={field.inputUI.type === 'codeEditor' ? 'flow-config-code' : ''}
          rows={field.inputUI.type === 'codeEditor' ? 10 : 4}
          spellCheck={field.inputUI.type !== 'codeEditor'}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'directory':
    case 'text':
      return (
        <input
          {...common}
          type={field.type === 'number' ? 'number' : 'text'}
          step={field.type === 'number' ? 'any' : undefined}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

export function NodeConfig({ node, plugin, disabled, onSave, onClose }: Props): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const prefix = useId();
  const bufferKey = pluginInputBufferKey(window.location.pathname, node);
  const [initial] = useState(() => recoverPluginInputBuffer(node, inputBuffers.get(bufferKey)));
  const [inputs, setInputs] = useState(initial.inputs);
  const [raw, setRaw] = useState(initial.raw);
  const [rawError, setRawError] = useState<string | null>(initial.error);
  const fields = plugin?.details.inputs ?? [];
  const effective = effectiveInputs(fields, inputs);
  const configDirty = raw !== JSON.stringify(node.inputs, null, 2);
  useNavigationGuard(configDirty);
  const rememberInputs = (
    nextInputs: Record<string, unknown>,
    nextRaw: string,
    error: string | null,
  ): void => {
    if (nextRaw === JSON.stringify(node.inputs, null, 2)) inputBuffers.delete(bufferKey);
    else
      inputBuffers.set(bufferKey, {
        baseline: initial.baseline,
        inputs: nextInputs,
        raw: nextRaw,
        error,
      });
  };
  const requestClose = (): void => {
    if (!configDirty || window.confirm('Discard the unapplied changes to this node’s inputs?')) {
      inputBuffers.delete(bufferKey);
      onClose();
    }
  };

  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  const update = (name: string, value: unknown): void => {
    const next = updatePluginInput(fields, inputs, name, value);
    setInputs(next);
    setRaw(JSON.stringify(next, null, 2));
    setRawError(null);
    rememberInputs(next, JSON.stringify(next, null, 2), null);
  };

  return (
    <dialog
      className="flow-config-dialog"
      ref={dialog}
      aria-labelledby={`${prefix}-title`}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          ) {
            requestClose();
          }
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && !rawError) {
            inputBuffers.delete(bufferKey);
            onSave({ ...node, inputs });
          }
        }}
      >
        <header className="flow-config-header">
          <div>
            <h2 id={`${prefix}-title`}>Configure {plugin?.name ?? node.pluginId}</h2>
            <p className="detail">
              {node.id} · Version {node.pluginVersion}
            </p>
          </div>
          <button type="button" onClick={requestClose} aria-label="Close configuration">
            Close
          </button>
        </header>
        <p>
          {plugin?.description ?? 'Plugin metadata is unavailable. Edit preserved inputs as JSON.'}
        </p>
        {initial.raw !== JSON.stringify(node.inputs, null, 2) && (
          <p className="flow-canvas-warning" role="status">
            Recovered unapplied configuration from this tab after an interruption. Apply to draft to
            keep these changes, or Cancel to discard them.
          </p>
        )}
        {(!plugin || !plugin.enabled) && (
          <p className="flow-canvas-warning" role="status">
            {plugin ? 'This plugin is disabled.' : 'This plugin is not installed.'} Its saved
            version and inputs will be preserved. Publishing may require fixing the plugin first.
          </p>
        )}
        {plugin && plugin.version !== node.pluginVersion && (
          <p className="flow-canvas-warning">
            Installed version {plugin.version} differs from this node’s saved version. Configuration
            uses installed metadata; saving does not change the pinned version.
          </p>
        )}
        <fieldset disabled={disabled} className="flow-config-fields">
          <legend>Plugin inputs</legend>
          {fields.length === 0 && <p className="detail">No configurable fields are declared.</p>}
          {fields
            .filter((field) => isInputVisible(field, fields, inputs))
            .map((field, index) => {
              const id = `${prefix}-input-${index}`;
              return (
                <div className="flow-config-field" key={field.name}>
                  <label htmlFor={id}>{field.label || field.name}</label>
                  <InputField
                    field={field}
                    id={id}
                    value={effective[field.name]}
                    onChange={(value) => update(field.name, value)}
                  />
                  <p id={`${id}-help`} className="help">
                    {field.tooltip}
                    {field.inputUI.type === 'directory' &&
                      ' Enter a path on the daemon filesystem.'}
                  </p>
                </div>
              );
            })}
          <details open={!plugin}>
            <summary>All inputs as JSON (including hidden and unrecognized values)</summary>
            <p className="help">
              Hidden fields and unknown keys are retained. Only edit values you intend to change.
            </p>
            <textarea
              aria-label="All plugin inputs as JSON"
              className="flow-config-code"
              rows={10}
              spellCheck={false}
              value={raw}
              aria-invalid={rawError !== null}
              aria-describedby={rawError ? `${prefix}-json-error` : undefined}
              onChange={(event) => {
                const nextRaw = event.target.value;
                setRaw(nextRaw);
                try {
                  const nextInputs = parseInputObject(nextRaw);
                  setInputs(nextInputs);
                  setRawError(null);
                  rememberInputs(nextInputs, nextRaw, null);
                } catch (error) {
                  const message = error instanceof Error ? error.message : 'Invalid JSON.';
                  setRawError(message);
                  rememberInputs(inputs, nextRaw, message);
                }
              }}
            />
            {rawError && (
              <p className="flow-canvas-error" id={`${prefix}-json-error`} role="alert">
                {rawError}
              </p>
            )}
          </details>
        </fieldset>
        <footer className="flow-config-actions">
          <button type="button" onClick={requestClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={disabled || rawError !== null}>
            Apply to draft
          </button>
        </footer>
      </form>
    </dialog>
  );
}
