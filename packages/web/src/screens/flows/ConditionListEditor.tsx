import type { FlowFieldCatalogue } from './plugin-input-model.js';
import {
  addRow,
  COMPARISONS,
  comparisonNeedsValue,
  conditionProblems,
  groupProperties,
  inputsWithRows,
  removeRow,
  rowsFromInputs,
  type ConditionRow,
} from './condition-editor-model.js';

/** Picking this in the property list starts a free-text custom property. */
const CUSTOM = '__custom__';

/**
 * Check Condition's inputs as rows — property, comparison, value — in place
 * of the generic editor's twelve numbered fields and their help text.
 *
 * Reads the node's STORED inputs, never the defaults-filled view, so a node in
 * the old flat format opens showing exactly the conditions it evaluates. It
 * converts to the list only when a row is actually changed: opening and
 * applying an old node untouched leaves it, and its flow's signature, alone.
 */
export function ConditionListEditor(props: {
  inputs: Record<string, unknown>;
  catalogue: FlowFieldCatalogue | null;
  disabled: boolean;
  idPrefix: string;
  onChange: (inputs: Record<string, unknown>) => void;
}): JSX.Element {
  const { inputs, catalogue, disabled, idPrefix, onChange } = props;
  const rows = rowsFromInputs(inputs);
  const known = new Set(catalogue?.fields.map((field) => field.name) ?? []);
  const groups = groupProperties(catalogue?.fields ?? []);
  const problems = conditionProblems(rows);
  const match = inputs.match === 'any' ? 'any' : 'all';
  const caseSensitive = inputs.caseSensitive === true || inputs.caseSensitive === 'true';

  const setRows = (next: ConditionRow[]): void => onChange(inputsWithRows(inputs, next));
  const setRow = (index: number, patch: Partial<ConditionRow>): void =>
    setRows(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));

  return (
    <div className="condition-editor">
      <div className="condition-match">
        <label htmlFor={`${idPrefix}-match`}>Match</label>
        <select
          id={`${idPrefix}-match`}
          value={match}
          disabled={disabled}
          onChange={(event) => onChange({ ...inputs, match: event.target.value })}
        >
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        <span>of these conditions</span>
      </div>

      <ol className="condition-rows">
        {rows.map((row, index) => {
          const n = String(index + 1);
          // A property outside the catalogue is a custom one — a user.*,
          // library.* or global.* variable — typed rather than picked.
          const custom = catalogue !== null && row.field !== '' && !known.has(row.field);
          return (
            <li className="condition-row" key={index}>
              <div className="condition-property">
                {catalogue === null ? (
                  <input
                    aria-label={`Condition ${n} property`}
                    value={row.field}
                    disabled={disabled}
                    placeholder="video.codec"
                    onChange={(event) => setRow(index, { field: event.target.value })}
                  />
                ) : (
                  <>
                    <select
                      aria-label={`Condition ${n} property`}
                      value={custom ? CUSTOM : row.field}
                      disabled={disabled}
                      onChange={(event) =>
                        // `user.` gives a custom name a namespace to finish,
                        // and marks the row custom so the text box appears.
                        setRow(index, {
                          field: event.target.value === CUSTOM ? 'user.' : event.target.value,
                        })
                      }
                    >
                      <option value="">Choose a property…</option>
                      {groups.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.fields.map((field) => (
                            <option key={field.name} value={field.name} title={field.description}>
                              {field.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      <option value={CUSTOM}>Custom…</option>
                    </select>
                    {custom && (
                      <input
                        aria-label={`Condition ${n} custom property`}
                        value={row.field}
                        disabled={disabled}
                        onChange={(event) => setRow(index, { field: event.target.value })}
                      />
                    )}
                  </>
                )}
              </div>
              <select
                aria-label={`Condition ${n} comparison`}
                value={row.operator}
                disabled={disabled}
                onChange={(event) => setRow(index, { operator: event.target.value })}
              >
                {COMPARISONS.map((comparison) => (
                  <option
                    key={comparison.operator}
                    value={comparison.operator}
                    title={comparison.operator}
                  >
                    {comparison.label}
                  </option>
                ))}
              </select>
              {comparisonNeedsValue(row.operator) ? (
                <input
                  aria-label={`Condition ${n} value`}
                  value={row.value}
                  disabled={disabled}
                  onChange={(event) => setRow(index, { value: event.target.value })}
                />
              ) : (
                // Holds the column, so rows with and without a value line up.
                <span aria-hidden="true" />
              )}
              <button
                type="button"
                className="btn-ghost condition-remove"
                aria-label={`Remove condition ${n}`}
                title="Remove"
                disabled={disabled || rows.length <= 1}
                onClick={() => setRows(removeRow(rows, index))}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>

      <div className="condition-footer">
        <button type="button" disabled={disabled} onClick={() => setRows(addRow(rows))}>
          + Add condition
        </button>
        <label className="condition-case">
          <input
            type="checkbox"
            checked={caseSensitive}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...inputs, caseSensitive: event.target.checked ? 'true' : 'false' })
            }
          />
          Case-sensitive
        </label>
      </div>

      {problems.length > 0 && (
        <p className="flow-canvas-error" role="alert">
          {problems.join(' ')}
        </p>
      )}
    </div>
  );
}

/** Whether the rows can be applied: the node would fail at run time otherwise. */
export const conditionEditorBlocks = (inputs: Record<string, unknown>): boolean =>
  conditionProblems(rowsFromInputs(inputs)).length > 0;
