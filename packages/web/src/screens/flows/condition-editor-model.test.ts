import { describe, expect, it } from 'vitest';
import {
  addRow,
  COMPARISONS,
  comparisonNeedsValue,
  conditionProblems,
  groupProperties,
  inputsWithRows,
  removeRow,
  rowsFromInputs,
} from './condition-editor-model.js';

describe('rowsFromInputs', () => {
  it('reads the list the editor writes, as JSON text', () => {
    const rows = [{ field: 'video.codec', operator: 'equals', value: 'hevc' }];
    expect(rowsFromInputs({ conditions: JSON.stringify(rows) })).toEqual(rows);
  });

  it('reads a list stored as an array too', () => {
    const rows = [{ field: 'audio.count', operator: 'at least', value: '1' }];
    expect(rowsFromInputs({ conditions: rows })).toEqual(rows);
  });

  it('reads the production check_preconditions node, stored in the old flat format', () => {
    expect(
      rowsFromInputs({
        conditionCount: '2',
        match: 'all',
        caseSensitive: 'false',
        field1: 'file.container',
        operator1: 'equals',
        value1: 'mkv',
        field2: 'video.codec',
        operator2: 'equals',
        value2: 'hevc',
      }),
    ).toEqual([
      { field: 'file.container', operator: 'equals', value: 'mkv' },
      { field: 'video.codec', operator: 'equals', value: 'hevc' },
    ]);
  });

  it('fills a missing flat slot with the defaults the node itself reads', () => {
    // A node the old generic editor saved with only its count: the node reads
    // field1 as video.codec, equals, hevc, so the rows must show the same.
    expect(rowsFromInputs({ conditionCount: '1' })).toEqual([
      { field: 'video.codec', operator: 'equals', value: 'hevc' },
    ]);
  });

  it("starts a node with nothing stored on the node's own default condition", () => {
    expect(rowsFromInputs({})).toEqual([
      { field: 'video.codec', operator: 'equals', value: 'hevc' },
    ]);
  });
});

describe('inputsWithRows', () => {
  it('writes the list as JSON text and drops the old flat keys', () => {
    const next = inputsWithRows(
      {
        match: 'any',
        conditionCount: '1',
        field1: 'video.codec',
        operator1: 'equals',
        value1: 'x',
      },
      [{ field: 'audio.count', operator: 'at least', value: '2' }],
    );
    expect(next).toEqual({
      match: 'any',
      conditions: JSON.stringify([{ field: 'audio.count', operator: 'at least', value: '2' }]),
    });
  });

  it('clears the value of a comparison that takes none, so no stale text is stored', () => {
    const next = inputsWithRows({}, [
      { field: 'error.message', operator: 'is missing', value: 'old' },
    ]);
    expect(JSON.parse(String(next.conditions))).toEqual([
      { field: 'error.message', operator: 'is missing', value: '' },
    ]);
  });
});

describe('rows', () => {
  const one = [{ field: 'video.codec', operator: 'equals', value: 'hevc' }];

  it('adds a blank row to fill in', () => {
    expect(addRow(one)).toEqual([...one, { field: '', operator: 'equals', value: '' }]);
  });

  it('removes a row, but never the last one', () => {
    expect(removeRow(addRow(one), 1)).toEqual(one);
    expect(removeRow(one, 0)).toEqual(one);
  });

  it('flags a row with no property, since the node would fail on it', () => {
    expect(conditionProblems(addRow(one))).toEqual(['Condition 2 needs a property.']);
    expect(conditionProblems(one)).toEqual([]);
  });
});

describe('comparisons', () => {
  it('covers every operator the node understands, each with a short label', () => {
    expect(COMPARISONS.map((comparison) => comparison.operator)).toEqual([
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
    ]);
  });

  it('takes no value for exists and is missing', () => {
    expect(comparisonNeedsValue('exists')).toBe(false);
    expect(comparisonNeedsValue('is missing')).toBe(false);
    expect(comparisonNeedsValue('at least')).toBe(true);
  });
});

describe('groupProperties', () => {
  it('groups the catalogue by what each property describes, in reading order', () => {
    const groups = groupProperties([
      { name: 'video.codec', description: '' },
      { name: 'file.path', description: '' },
      { name: 'audio.count', description: '' },
      { name: 'original.path', description: '' },
      { name: 'error.message', description: '' },
      { name: 'job.id', description: '' },
      { name: 'subtitle.count', description: '' },
    ]);
    expect(groups.map((group) => [group.label, group.fields.map((field) => field.name)])).toEqual([
      ['File', ['file.path', 'original.path']],
      ['Video', ['video.codec']],
      ['Audio', ['audio.count']],
      ['Subtitle', ['subtitle.count']],
      ['Job', ['job.id']],
      ['Error', ['error.message']],
    ]);
  });
});
