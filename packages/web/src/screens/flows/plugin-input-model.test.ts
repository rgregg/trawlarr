import { describe, expect, it } from 'vitest';
import type { InputCondition, PluginInput } from '@trawlarr/plugin-api';
import {
  coerceInputValue,
  effectiveInputs,
  inputDefaults,
  inputText,
  isInputVisible,
  parseInputObject,
  pluginInputBufferKey,
  recoverPluginInputBuffer,
  updatePluginInput,
} from './plugin-input-model.js';

const field = (overrides: Partial<PluginInput> = {}): PluginInput => ({
  name: 'codec',
  label: 'Codec',
  type: 'string',
  defaultValue: 'hevc',
  tooltip: 'Codec to encode',
  inputUI: { type: 'text' },
  ...overrides,
});

describe('plugin input values', () => {
  it('uses declared types for defaults without treating the string false as truthy', () => {
    expect(
      inputDefaults([
        field(),
        field({ name: 'enabled', type: 'boolean', defaultValue: 'false' }),
        field({ name: 'quality', type: 'number', defaultValue: '22.5' }),
      ]),
    ).toEqual({ codec: 'hevc', enabled: false, quality: 22.5 });
  });

  it('preserves explicit false, zero, empty and unknown values rather than defaulting them', () => {
    const inputs = { codec: '', enabled: false, quality: 0, privateKey: { nested: [1, 'x'] } };
    expect(
      effectiveInputs(
        [
          field(),
          field({ name: 'enabled', type: 'boolean', defaultValue: 'true' }),
          field({ name: 'quality', type: 'number', defaultValue: '22' }),
        ],
        inputs,
      ),
    ).toEqual(inputs);
    expect(inputs.privateKey).toEqual({ nested: [1, 'x'] });
  });

  it.each(['', 'not-a-number', 'Infinity', 'NaN'])('retains invalid numeric value %j', (value) => {
    expect(coerceInputValue(field({ type: 'number' }), value)).toBe(value);
  });

  it('never turns invalid booleans into true', () => {
    expect(coerceInputValue(field({ type: 'boolean' }), 'unknown')).toBe('unknown');
    expect(coerceInputValue(field({ type: 'boolean' }), 'false')).toBe(false);
    expect(coerceInputValue(field({ type: 'boolean' }), 'true')).toBe(true);
    expect(coerceInputValue(field({ type: 'string' }), false)).toBe('false');
  });

  it.each(['dropdown', 'text', 'textarea', 'directory', 'slider', 'switch', 'codeEditor'] as const)(
    'updates %s fields without destroying hidden or unknown inputs',
    (type) => {
      const inputs = { codec: 'h264', hidden: { complex: true }, extension: [1, 2] };
      const next = updatePluginInput([field({ inputUI: { type } })], inputs, 'codec', 'hevc');
      expect(next).toEqual({ codec: 'hevc', hidden: { complex: true }, extension: [1, 2] });
      expect(inputs.codec).toBe('h264');
    },
  );

  it('onSelect rewrites siblings using their declared types, retaining all other keys', () => {
    const fields = [
      field({
        inputUI: {
          type: 'dropdown',
          options: ['hevc', 'h264'],
          onSelect: {
            hevc: { quality: '24', enabled: 'false', hidden: 'new', futureField: 'yes' },
          },
        },
      }),
      field({ name: 'quality', type: 'number' }),
      field({ name: 'enabled', type: 'boolean' }),
    ];
    const inputs = { quality: 10, enabled: true, hidden: 'old', unknown: { value: 1 } };
    expect(updatePluginInput(fields, inputs, 'codec', 'hevc')).toEqual({
      codec: 'hevc',
      quality: 24,
      enabled: false,
      hidden: 'new',
      futureField: 'yes',
      unknown: { value: 1 },
    });
    expect(inputs.quality).toBe(10);
  });

  it('does not materialize defaults when editing a different field', () => {
    expect(updatePluginInput([field(), field({ name: 'other' })], {}, 'codec', 'h264')).toEqual({
      codec: 'h264',
    });
  });

  it('stringifies rich values and rejects JSON which is not an input object', () => {
    expect(inputText({ keep: [true] })).toBe('{"keep":[true]}');
    expect(inputText(undefined)).toBe('');
    expect(inputText(false)).toBe('false');
    expect(parseInputObject('{"hidden":{"items":[1]},"enabled":false}')).toEqual({
      hidden: { items: [1] },
      enabled: false,
    });
    for (const invalid of ['null', '[]', 'true', '"text"', '{']) {
      expect(() => parseInputObject(invalid)).toThrow();
    }
  });
});

describe('metadata display conditions', () => {
  const conditional = (condition: InputCondition, value = '10'): PluginInput =>
    field({
      name: 'conditional',
      inputUI: {
        type: 'text',
        displayConditions: {
          logic: 'AND',
          sets: [{ logic: 'AND', inputs: [{ name: 'value', condition, value }] }],
        },
      },
    });

  describe('interrupted configuration recovery', () => {
    const node = { id: 'check', pluginId: 'codec', pluginVersion: '1', inputs: { codec: 'hevc' } };

    it('scopes buffered inputs to the flow, node and plugin identity', () => {
      expect(pluginInputBufferKey('/flows/one/edit', node)).not.toBe(
        pluginInputBufferKey('/flows/two/edit', node),
      );
      expect(pluginInputBufferKey('/flows/one/edit', node)).not.toBe(
        pluginInputBufferKey('/flows/one/edit', { ...node, id: 'other' }),
      );
      expect(pluginInputBufferKey('/flows/one/edit', node)).not.toBe(
        pluginInputBufferKey('/flows/one/edit', { ...node, pluginId: 'other' }),
      );
    });

    it('recovers unapplied values and even unfinished JSON after an auth interruption', () => {
      const buffered = {
        ...recoverPluginInputBuffer(node),
        inputs: { codec: 'h264', hidden: { keep: true } },
        raw: '{"codec":',
        error: 'Invalid JSON',
      };
      expect(recoverPluginInputBuffer(node, buffered)).toBe(buffered);
      expect(node.inputs).toEqual({ codec: 'hevc' });
    });

    it('never restores stale inputs over a changed saved node or plugin version', () => {
      const buffered = { ...recoverPluginInputBuffer(node), raw: '{"codec":"h264"}' };
      const changed = { ...node, inputs: { codec: 'av1' } };
      expect(recoverPluginInputBuffer(changed, buffered).inputs).toEqual({ codec: 'av1' });
      expect(recoverPluginInputBuffer({ ...node, pluginVersion: '2' }, buffered).raw).toBe(
        JSON.stringify(node.inputs, null, 2),
      );
    });
  });

  it.each([
    ['===', 10, true],
    ['===', 9, false],
    ['!==', 9, true],
    ['!==', 10, false],
    ['>', 11, true],
    ['>', 10, false],
    ['>=', 10, true],
    ['>=', 9, false],
    ['<', 9, true],
    ['<', 10, false],
    ['<=', 10, true],
    ['<=', 11, false],
  ] as const)('supports %s against %s', (condition, value, result) => {
    const target = conditional(condition);
    expect(
      isInputVisible(target, [field({ name: 'value', type: 'number' }), target], { value }),
    ).toBe(result);
  });

  it.each([
    ['includes', 'abc-hevc-xyz', true],
    ['includes', 'h264', false],
    ['notIncludes', 'h264', true],
    ['notIncludes', 'hevc', false],
  ] as const)('supports string %s', (condition, value, result) => {
    const target = conditional(condition, 'hevc');
    expect(isInputVisible(target, [target], { value })).toBe(result);
  });

  it('supports array membership and missing values', () => {
    const target = conditional('includes', 'hevc');
    expect(isInputVisible(target, [target], { value: ['h264', 'hevc'] })).toBe(true);
    expect(isInputVisible(target, [target], {})).toBe(false);
    expect(isInputVisible(conditional('>', '1'), [], {})).toBe(false);
    expect(isInputVisible(conditional('>', '1'), [], { value: 'oops' })).toBe(false);
  });

  it('evaluates nested AND/OR sets using defaults without persisting them', () => {
    const target = field({
      name: 'conditional',
      inputUI: {
        type: 'text',
        displayConditions: {
          logic: 'OR',
          sets: [
            {
              logic: 'AND',
              inputs: [
                { name: 'enabled', value: 'true', condition: '===' },
                { name: 'codec', value: 'hevc', condition: '===' },
              ],
            },
            {
              logic: 'OR',
              inputs: [
                { name: 'mode', value: 'force', condition: '===' },
                { name: 'quality', value: '20', condition: '<' },
              ],
            },
          ],
        },
      },
    });
    const fields = [
      field(),
      field({ name: 'enabled', type: 'boolean', defaultValue: 'true' }),
      field({ name: 'quality', type: 'number', defaultValue: '24' }),
      target,
    ];
    const inputs = {};
    expect(isInputVisible(target, fields, inputs)).toBe(true);
    expect(inputs).toEqual({});
    expect(isInputVisible(target, fields, { enabled: false })).toBe(false);
    expect(isInputVisible(target, fields, { enabled: false, mode: 'force' })).toBe(true);
    expect(isInputVisible(target, fields, { enabled: false, quality: 19 })).toBe(true);
    expect(isInputVisible(target, fields, { enabled: 'true' })).toBe(true);
    const both = {
      ...target,
      inputUI: {
        ...target.inputUI,
        displayConditions: { ...target.inputUI.displayConditions!, logic: 'AND' as const },
      },
    };
    expect(isInputVisible(both, fields, { mode: 'force', enabled: false })).toBe(false);
    expect(isInputVisible(both, fields, { mode: 'force' })).toBe(true);
  });

  it('shows fields without conditions and those with an empty condition list', () => {
    expect(isInputVisible(field(), [], {})).toBe(true);
    expect(
      isInputVisible(
        field({ inputUI: { type: 'text', displayConditions: { logic: 'OR', sets: [] } } }),
        [],
        {},
      ),
    ).toBe(true);
  });
});
