import type {
  PluginDetails,
  PluginInput,
  PluginInputArgs,
  PluginOutputArgs,
} from '@trawlarr/plugin-api';
import {
  FLOW_FIELDS,
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

const visible = (
  index: number,
  needsValue = false,
): PluginInput['inputUI']['displayConditions'] => ({
  logic: 'AND',
  sets: [
    {
      logic: 'AND',
      inputs: [
        { name: 'conditionCount', condition: '>=', value: String(index) },
        ...(needsValue
          ? [
              { name: `operator${index}`, condition: '!==' as const, value: 'exists' },
              { name: `operator${index}`, condition: '!==' as const, value: 'is missing' },
            ]
          : []),
      ],
    },
  ],
});

const conditionFields = (index: number): PluginInput[] => [
  {
    name: `field${index}`,
    label: `Condition ${index}: property`,
    type: 'string',
    defaultValue: 'video.codec',
    tooltip:
      'Sizes are decimal MB or bytes as named; durations are seconds and bitrates are bits/second. HDR means PQ/HLG transfer metadata. Use contains for language/codec lists; missing facts match only "is missing". Custom user.*, library.* and global.* properties can also be entered in the input JSON.',
    inputUI: { type: 'dropdown', options: FLOW_FIELDS, displayConditions: visible(index) },
  },
  {
    name: `operator${index}`,
    label: `Condition ${index}: comparison`,
    type: 'string',
    defaultValue: 'equals',
    tooltip: 'Numeric comparisons require numbers. Exists and is missing do not need a value.',
    inputUI: { type: 'dropdown', options: OPERATORS, displayConditions: visible(index) },
  },
  {
    name: `value${index}`,
    label: `Condition ${index}: value`,
    type: 'string',
    defaultValue: 'hevc',
    tooltip:
      'Text, a number, true/false, or a {{property}} placeholder. For lists use contains with one exact item, such as eng.',
    inputUI: { type: 'text', displayConditions: visible(index, true) },
  },
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
      name: 'conditionCount',
      label: 'Number of conditions',
      type: 'number',
      defaultValue: '1',
      tooltip:
        'Use 1-4 conditions here, or connect multiple Check Condition nodes for larger or nested rules.',
      inputUI: { type: 'dropdown', options: ['1', '2', '3', '4'] },
    },
    {
      name: 'match',
      label: 'Match',
      type: 'string',
      defaultValue: 'all',
      tooltip: 'all = AND; any = OR. Every enabled condition is checked for configuration errors.',
      inputUI: { type: 'dropdown', options: ['all', 'any'] },
    },
    {
      name: 'caseSensitive',
      label: 'Case-sensitive text comparisons',
      type: 'boolean',
      defaultValue: 'false',
      tooltip: 'Numbers and booleans are always compared by value.',
      inputUI: { type: 'switch' },
    },
    ...[1, 2, 3, 4].flatMap(conditionFields),
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

export const checkConditions = (args: FlowValueArgs, inputs: Record<string, unknown>) => {
  const count = numberValue(inputs.conditionCount ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 4)
    throw new Error('Choose between 1 and 4 conditions.');
  const mode = inputs.match ?? 'all';
  if (mode !== 'all' && mode !== 'any') throw new Error('Condition match must be all or any.');
  const caseSensitive = textBoolean(inputs.caseSensitive ?? false);
  const checks = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const field = String(inputs[`field${index}`] ?? 'video.codec');
    const operator = String(inputs[`operator${index}`] ?? 'equals');
    const actual = readFlowValue(args, field);
    const expected =
      operator === 'exists' || operator === 'is missing'
        ? ''
        : renderMessageTemplate(args, String(inputs[`value${index}`] ?? 'hevc'));
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
