import { describe, expect, it } from 'vitest';
import { InvalidFlowLayoutError, parseFlowLayout } from './layout.js';

describe('flow layout validation', () => {
  it('accepts finite positions, including newly drafted nodes and negative coordinates', () => {
    expect(parseFlowLayout({ draftNode: { x: -25.5, y: 300 } })).toEqual({
      draftNode: { x: -25.5, y: 300 },
    });
    expect(parseFlowLayout({})).toEqual({});
  });

  it.each([
    undefined,
    null,
    [],
    'bad',
    { '': { x: 0, y: 0 } },
    { start: null },
    { start: [] },
    { start: {} },
    { start: { x: '4', y: 0 } },
    { start: { x: 0, y: Infinity } },
    { start: { x: NaN, y: 0 } },
  ])('rejects malformed layout %j', (layout) => {
    expect(() => parseFlowLayout(layout)).toThrow(InvalidFlowLayoutError);
  });

  it('stores only coordinates and preserves IDs that coincide with object property names', () => {
    expect(parseFlowLayout({ start: { x: 1, y: 2, selected: true } })).toEqual({
      start: { x: 1, y: 2 },
    });
    const layout = parseFlowLayout(JSON.parse('{"__proto__":{"x":1,"y":2}}'));
    expect(Object.hasOwn(layout, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(layout)).toBe(Object.prototype);
  });
});
