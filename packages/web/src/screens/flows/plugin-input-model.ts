import type { InputDisplayCondition, PluginInput } from '@trawlarr/plugin-api';
import type { FlowNode } from '@trawlarr/core';

export type PluginInputBuffer = {
  baseline: string;
  inputs: Record<string, unknown>;
  raw: string;
  error: string | null;
};

export function pluginInputBufferKey(flowPath: string, node: FlowNode): string {
  return JSON.stringify([flowPath, node.id, node.pluginId]);
}

export function recoverPluginInputBuffer(
  node: FlowNode,
  buffered?: PluginInputBuffer,
): PluginInputBuffer {
  const baseline = JSON.stringify(node);
  if (buffered?.baseline === baseline) return buffered;
  return { baseline, inputs: node.inputs, raw: JSON.stringify(node.inputs, null, 2), error: null };
}

/** Invalid existing values stay visible instead of becoming a silently different value. */
export function coerceInputValue(input: PluginInput, value: unknown): unknown {
  if (input.type === 'boolean') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  }
  if (input.type === 'number') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return value;
  }
  return typeof value === 'string' ? value : String(value);
}

export function inputDefaults(fields: PluginInput[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => [field.name, coerceInputValue(field, field.defaultValue)]),
  );
}

export function effectiveInputs(
  fields: PluginInput[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  return { ...inputDefaults(fields), ...values };
}

function matchesCondition(
  condition: InputDisplayCondition,
  fields: PluginInput[],
  values: Record<string, unknown>,
): boolean {
  const field = fields.find((candidate) => candidate.name === condition.name);
  const stored = values[condition.name];
  const actual =
    field && stored !== undefined && stored !== null && typeof stored !== 'object'
      ? coerceInputValue(field, stored)
      : stored;
  const expected = field ? coerceInputValue(field, condition.value) : condition.value;
  switch (condition.condition) {
    case '===':
      return actual === expected;
    case '!==':
      return actual !== expected;
    case 'includes':
      return (
        (typeof actual === 'string' && actual.includes(condition.value)) ||
        (Array.isArray(actual) && actual.includes(expected))
      );
    case 'notIncludes':
      return !(
        (typeof actual === 'string' && actual.includes(condition.value)) ||
        (Array.isArray(actual) && actual.includes(expected))
      );
    default: {
      if (
        actual === undefined ||
        actual === null ||
        actual === '' ||
        expected === '' ||
        !Number.isFinite(Number(actual)) ||
        !Number.isFinite(Number(expected))
      ) {
        return false;
      }
      const left = Number(actual);
      const right = Number(expected);
      switch (condition.condition) {
        case '>':
          return left > right;
        case '>=':
          return left >= right;
        case '<':
          return left < right;
        case '<=':
          return left <= right;
      }
    }
  }
}

export function isInputVisible(
  field: PluginInput,
  fields: PluginInput[],
  inputs: Record<string, unknown>,
): boolean {
  const conditions = field.inputUI.displayConditions;
  if (!conditions || conditions.sets.length === 0) return true;
  const values = effectiveInputs(fields, inputs);
  const results = conditions.sets.map((set) => {
    const matches = set.inputs.map((condition) => matchesCondition(condition, fields, values));
    return set.logic === 'AND' ? matches.every(Boolean) : matches.some(Boolean);
  });
  return conditions.logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

export function updatePluginInput(
  fields: PluginInput[],
  inputs: Record<string, unknown>,
  name: string,
  value: unknown,
): Record<string, unknown> {
  const field = fields.find((candidate) => candidate.name === name);
  const next = { ...inputs, [name]: field ? coerceInputValue(field, value) : value };
  const rewrites = field?.inputUI.onSelect?.[String(value)];
  return {
    ...next,
    ...Object.fromEntries(
      Object.entries(rewrites ?? {}).map(([sibling, replacement]) => {
        const siblingField = fields.find((candidate) => candidate.name === sibling);
        return [sibling, siblingField ? coerceInputValue(siblingField, replacement) : replacement];
      }),
    ),
  };
}

export function inputText(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function parseInputObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Inputs must be a JSON object.');
  }
  return value as Record<string, unknown>;
}
