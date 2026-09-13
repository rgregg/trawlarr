import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import {
  readFlowValue,
  renderMessageTemplate,
  type FlowValue,
  type FlowValueArgs,
} from '../flow-values.js';

export const OPERATORS = [
  'equals',
  'not equals',
  'greater than',
  'at least',
  'less than',
  'at most',
  'contains',
  'does not contain',
  'exists',
  'is missing',
];

export const details = (): PluginDetails => ({
  name: 'Check Condition',
  description:
    'Branch using up to four media-property conditions, combined with AND or OR. Chain nodes for nested decisions.',
  style: { borderColor: '#1a6699' },
  tags: 'condition,branch,filter',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faCodeBranch',
  inputs: [
    {
      name: 'match',
      label: 'Match',
      type: 'string',
      defaultValue: 'all',
      tooltip: 'all = every condition; any = at least one.',
      inputUI: { type: 'dropdown', options: ['all', 'any'] },
    },
    {
      name: 'caseSensitive',
      label: 'Case-sensitive',
      type: 'boolean',
      defaultValue: 'false',
      tooltip: 'Numbers and booleans are always compared by value.',
      inputUI: { type: 'switch' },
    },
    {
      // The flow editor renders this as a list of rows; any other editor
      // sees the JSON. A list, not numbered flat inputs, because inputs are
      // declared up front and a declared set is a fixed maximum — the old
      // field1..4 format capped a node at four conditions for that reason.
      name: 'conditions',
      label: 'Conditions',
      type: 'string',
      defaultValue: JSON.stringify([{ field: 'video.codec', operator: 'equals', value: 'hevc' }]),
      tooltip: 'A list of { field, operator, value } rows.',
      inputUI: { type: 'text' },
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Conditions match' },
    { number: 2, tooltip: 'Conditions do not match' },
  ],
  requiresVersion: '1.0.0',
});

const numberValue = (value: unknown): number => {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    String(value).trim() === '' ||
    !Number.isFinite(Number(value))
  )
    throw new Error(`Condition needs a finite number, got "${String(value)}".`);
  return Number(value);
};

const textBoolean = (value: unknown): boolean => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`Condition needs true or false, got "${String(value)}".`);
};

export const compareValue = (
  actual: FlowValue | undefined,
  operator: string,
  expected: string,
  caseSensitive: boolean,
): boolean => {
  if (!OPERATORS.includes(operator)) throw new Error(`Unknown condition comparison "${operator}".`);
  if (operator === 'exists') return actual !== undefined;
  if (operator === 'is missing') return actual === undefined;
  if (['greater than', 'at least', 'less than', 'at most'].includes(operator))
    numberValue(expected);
  if (actual === undefined) return false;
  const normalize = (value: string): string => (caseSensitive ? value : value.toLowerCase());
  if (operator === 'contains' || operator === 'does not contain') {
    if (typeof actual !== 'string' && !Array.isArray(actual))
      throw new Error('Contains needs text or a list property.');
    const found = Array.isArray(actual)
      ? actual.some((value) => normalize(value) === normalize(expected))
      : normalize(actual).includes(normalize(expected));
    return operator === 'contains' ? found : !found;
  }
  if (Array.isArray(actual))
    throw new Error('Use contains or does not contain for a list property.');
  if (operator === 'equals' || operator === 'not equals') {
    const matches =
      typeof actual === 'number'
        ? actual === numberValue(expected)
        : typeof actual === 'boolean'
          ? actual === textBoolean(expected)
          : normalize(actual) === normalize(expected);
    return operator === 'equals' ? matches : !matches;
  }
  const left = numberValue(actual);
  const right = numberValue(expected);
  switch (operator) {
    case 'greater than':
      return left > right;
    case 'at least':
      return left >= right;
    case 'less than':
      return left < right;
    case 'at most':
      return left <= right;
    default:
      throw new Error(`Unsupported comparison "${operator}".`);
  }
};

export interface Condition {
  field: string;
  operator: string;
  value: string;
}

/**
 * The conditions a node holds.
 *
 * The `conditions` list when the node has one. Otherwise the flat
 * `conditionCount` + `field{n}`/`operator{n}`/`value{n}` format every node
 * was stored in before the list existed — read here, never rewritten here,
 * so a stored flow keeps both its meaning and its signature until someone
 * saves the node in the editor. That format only ever declared four slots,
 * so its count stays capped at four; the list has no cap.
 */
export const conditionsFrom = (inputs: Record<string, unknown>): Condition[] => {
  if (inputs.conditions !== undefined) {
    // A stored flow may carry the list as JSON text (the declared default is
    // one) or as the array the editor writes.
    let list: unknown = inputs.conditions;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list) as unknown;
      } catch {
        throw new Error('Conditions must be a list of { field, operator, value } rows.');
      }
    }
    if (!Array.isArray(list)) {
      throw new Error('Conditions must be a list of { field, operator, value } rows.');
    }
    if (list.length === 0) throw new Error('Add at least one condition.');
    return list.map((entry: unknown, offset) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const field = String(row.field ?? '').trim();
      if (field === '') throw new Error(`Condition ${String(offset + 1)} has no property.`);
      return {
        field,
        operator: String(row.operator ?? 'equals'),
        value: String(row.value ?? ''),
      };
    });
  }

  const count = numberValue(inputs.conditionCount ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 4)
    throw new Error('Choose between 1 and 4 conditions.');
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    return {
      field: String(inputs[`field${index}`] ?? 'video.codec'),
      operator: String(inputs[`operator${index}`] ?? 'equals'),
      value: String(inputs[`value${index}`] ?? 'hevc'),
    };
  });
};

export const checkConditions = (args: FlowValueArgs, inputs: Record<string, unknown>) => {
  const conditions = conditionsFrom(inputs);
  const mode = inputs.match ?? 'all';
  if (mode !== 'all' && mode !== 'any') throw new Error('Condition match must be all or any.');
  const caseSensitive = textBoolean(inputs.caseSensitive ?? false);
  // Every row is evaluated, never short-circuited: a misconfigured row after
  // one that already decided the result must still fail loudly rather than
  // wait for the one file where it finally gets reached.
  const checks = conditions.map(({ field, operator, value }) => {
    const actual = readFlowValue(args, field);
    const expected =
      operator === 'exists' || operator === 'is missing' ? '' : renderMessageTemplate(args, value);
    const matches = compareValue(actual, operator, expected, caseSensitive);
    return {
      matches,
      message: `${field}: ${actual === undefined ? '(missing)' : JSON.stringify(actual)} ${operator} ${JSON.stringify(expected)} => ${matches ? 'match' : 'no match'}`,
    };
  });
  return {
    matches:
      mode === 'all'
        ? checks.every((check) => check.matches)
        : checks.some((check) => check.matches),
    checks,
  };
};

export const plugin = (args: PluginInputArgs): PluginOutputArgs => {
  const result = checkConditions(args, args.inputs);
  for (const check of result.checks) args.jobLog(check.message);
  return {
    outputNumber: result.matches ? 1 : 2,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};
