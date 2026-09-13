/**
 * The Check Condition editor: rows of property, comparison and value, in
 * place of the generic editor's numbered fields.
 *
 * The node reads its conditions in `checkCondition/index.ts` (`conditionsFrom`).
 * The web bundle imports nothing at runtime from the plugin packages, so the
 * reading of the OLD flat format is repeated here — deliberately small, and
 * frozen: that format is never written again, only read until each node is
 * next saved. Its defaults must match the node's, or an old node would open
 * showing a condition it does not evaluate.
 */

export interface ConditionRow {
  field: string;
  operator: string;
  value: string;
}

/** Every comparison the node understands, labelled the way a person reads it. */
export const COMPARISONS: ReadonlyArray<{ operator: string; label: string; needsValue: boolean }> =
  [
    { operator: 'equals', label: '=', needsValue: true },
    { operator: 'not equals', label: '≠', needsValue: true },
    { operator: 'greater than', label: '>', needsValue: true },
    { operator: 'at least', label: '≥', needsValue: true },
    { operator: 'less than', label: '<', needsValue: true },
    { operator: 'at most', label: '≤', needsValue: true },
    { operator: 'contains', label: 'contains', needsValue: true },
    { operator: 'does not contain', label: "doesn't contain", needsValue: true },
    { operator: 'exists', label: 'exists', needsValue: false },
    { operator: 'is missing', label: 'is missing', needsValue: false },
  ];

export const comparisonNeedsValue = (operator: string): boolean =>
  COMPARISONS.find((comparison) => comparison.operator === operator)?.needsValue ?? true;

/** The node's own default condition, and the old flat format's per-slot defaults. */
const DEFAULT_ROW: ConditionRow = { field: 'video.codec', operator: 'equals', value: 'hevc' };

const LEGACY_KEYS = [
  'conditionCount',
  ...[1, 2, 3, 4].flatMap((n) => [
    `field${String(n)}`,
    `operator${String(n)}`,
    `value${String(n)}`,
  ]),
];

const toRow = (entry: unknown): ConditionRow => {
  const row = (entry ?? {}) as Record<string, unknown>;
  return {
    field: String(row.field ?? ''),
    operator: String(row.operator ?? 'equals'),
    value: String(row.value ?? ''),
  };
};

/** The rows a node's stored inputs describe: its list, or the old flat slots. */
export const rowsFromInputs = (inputs: Record<string, unknown>): ConditionRow[] => {
  if (inputs.conditions !== undefined) {
    let list: unknown = inputs.conditions;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list) as unknown;
      } catch {
        return [{ ...DEFAULT_ROW }];
      }
    }
    return Array.isArray(list) && list.length > 0 ? list.map(toRow) : [{ ...DEFAULT_ROW }];
  }
  if (inputs.conditionCount === undefined) return [{ ...DEFAULT_ROW }];
  const count = Math.min(4, Math.max(1, Math.trunc(Number(inputs.conditionCount)) || 1));
  return Array.from({ length: count }, (_, offset) => {
    const n = String(offset + 1);
    return {
      field: String(inputs[`field${n}`] ?? DEFAULT_ROW.field),
      operator: String(inputs[`operator${n}`] ?? DEFAULT_ROW.operator),
      value: String(inputs[`value${n}`] ?? DEFAULT_ROW.value),
    };
  });
};

/**
 * The inputs to store for these rows.
 *
 * The list is written as JSON TEXT, not an array: the node declares it as a
 * string input, and the editor's input plumbing coerces a string input with
 * `String(value)`, which would store an array as "[object Object]". The node
 * parses the text. The old flat keys are removed, since the list now decides
 * and leaving them would show a second, ignored set of conditions in the raw
 * JSON.
 */
export const inputsWithRows = (
  inputs: Record<string, unknown>,
  rows: ReadonlyArray<ConditionRow>,
): Record<string, unknown> => {
  const kept = Object.fromEntries(
    Object.entries(inputs).filter(([key]) => !LEGACY_KEYS.includes(key)),
  );
  const cleaned = rows.map((row) => ({
    field: row.field,
    operator: row.operator,
    value: comparisonNeedsValue(row.operator) ? row.value : '',
  }));
  return { ...kept, conditions: JSON.stringify(cleaned) };
};

export const addRow = (rows: ReadonlyArray<ConditionRow>): ConditionRow[] => [
  ...rows,
  { field: '', operator: 'equals', value: '' },
];

/** A node needs at least one condition, so the last row cannot be removed. */
export const removeRow = (rows: ReadonlyArray<ConditionRow>, index: number): ConditionRow[] =>
  rows.length <= 1 ? [...rows] : rows.filter((_, position) => position !== index);

/** What would stop the node running, said before the node is saved rather than at run time. */
export const conditionProblems = (rows: ReadonlyArray<ConditionRow>): string[] =>
  rows.flatMap((row, index) =>
    row.field.trim() === '' ? [`Condition ${String(index + 1)} needs a property.`] : [],
  );

const GROUPS: ReadonlyArray<{ label: string; prefixes: readonly string[] }> = [
  { label: 'File', prefixes: ['file', 'original'] },
  { label: 'Video', prefixes: ['video'] },
  { label: 'Audio', prefixes: ['audio'] },
  { label: 'Subtitle', prefixes: ['subtitle'] },
  { label: 'Job', prefixes: ['job'] },
  { label: 'Error', prefixes: ['error'] },
];

/** The property catalogue grouped for the picker, in reading order; empty groups are dropped. */
export const groupProperties = <T extends { name: string }>(
  fields: ReadonlyArray<T>,
): Array<{ label: string; fields: T[] }> =>
  GROUPS.map((group) => ({
    label: group.label,
    fields: fields.filter((field) => group.prefixes.includes(field.name.split('.')[0]!)),
  })).filter((group) => group.fields.length > 0);
