import { describe, expect, it } from 'vitest';
import { FLOW_NODE_NAME_MAX } from '@trawlarr/core';
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

  it('keeps a node name, which is presentation and never reaches the signature', () => {
    expect(parseFlowLayout({ start: { x: 1, y: 2, name: 'Is it already stereo AAC?' } })).toEqual({
      start: { x: 1, y: 2, name: 'Is it already stereo AAC?' },
    });
    // Multi-line, because a comment node carries its text as its name.
    expect(parseFlowLayout({ note: { x: 0, y: 0, name: 'Line one\nLine two' } }).note!.name).toBe(
      'Line one\nLine two',
    );
  });

  it('drops an empty name rather than storing "use the plugin name" as a value', () => {
    expect(parseFlowLayout({ start: { x: 1, y: 2, name: '' } })).toEqual({ start: { x: 1, y: 2 } });
    expect(parseFlowLayout({ start: { x: 1, y: 2, name: '   ' } })).toEqual({
      start: { x: 1, y: 2 },
    });
  });

  it.each([
    { start: { x: 1, y: 2, name: 42 } },
    { start: { x: 1, y: 2, name: null } },
    { start: { x: 1, y: 2, name: ['a'] } },
    { start: { x: 1, y: 2, name: 'x'.repeat(FLOW_NODE_NAME_MAX + 1) } },
  ])('rejects a malformed node name %j', (layout) => {
    expect(() => parseFlowLayout(layout)).toThrow(InvalidFlowLayoutError);
  });

  it('stores only coordinates and the name, and preserves IDs that coincide with property names', () => {
    expect(parseFlowLayout({ start: { x: 1, y: 2, selected: true } })).toEqual({
      start: { x: 1, y: 2 },
    });
    const layout = parseFlowLayout(JSON.parse('{"__proto__":{"x":1,"y":2}}'));
    expect(Object.hasOwn(layout, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(layout)).toBe(Object.prototype);
  });
});
