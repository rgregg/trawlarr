import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from './canonical-json.js';

describe('canonicalJson', () => {
  it('orders object keys so equal content hashes equally', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('orders keys recursively', () => {
    expect(canonicalJson({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined object values but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('renders undefined array entries as null to preserve positions', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('rejects values that cannot hash deterministically', () => {
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(/not serialisable/i);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/not serialisable/i);
  });

  it('rejects a Date instance instead of collapsing to {}', () => {
    expect(() => canonicalJson(new Date())).toThrow(/not serialisable/i);
    expect(() => canonicalJson(new Date())).toThrow(/date/i);
  });

  it('rejects a Map instance instead of collapsing to {}', () => {
    expect(() => canonicalJson(new Map([['a', 1]]))).toThrow(/not serialisable/i);
    expect(() => canonicalJson(new Map([['a', 1]]))).toThrow(/map/i);
  });

  it('rejects a Set instance instead of collapsing to {}', () => {
    expect(() => canonicalJson(new Set([1, 2, 3]))).toThrow(/not serialisable/i);
    expect(() => canonicalJson(new Set([1, 2, 3]))).toThrow(/set/i);
  });

  it('rejects a RegExp instance instead of collapsing to {}', () => {
    expect(() => canonicalJson(/abc/)).toThrow(/not serialisable/i);
    expect(() => canonicalJson(/abc/)).toThrow(/regexp/i);
  });

  it('rejects a class instance instead of collapsing to {}', () => {
    class Widget {
      name = 'widget';
    }
    expect(() => canonicalJson(new Widget())).toThrow(/not serialisable/i);
    expect(() => canonicalJson(new Widget())).toThrow(/widget/i);
  });

  it('serialises a null-prototype object normally', () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj.a = 1;
    obj.b = 2;
    expect(canonicalJson(obj)).toBe('{"a":1,"b":2}');
  });

  it('rejects a cyclic object with a comprehensible error, not a stack overflow', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalJson(obj)).toThrow(/circular/i);
  });

  it('still serialises the same object referenced from two sibling keys', () => {
    const shared = { x: 1 };
    const parent = { a: shared, b: shared };
    expect(canonicalJson(parent)).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('sha256Hex', () => {
  it('produces a stable 64-character digest', () => {
    const digest = sha256Hex('trawlarr');
    expect(digest).toHaveLength(64);
    expect(digest).toBe(sha256Hex('trawlarr'));
    expect(digest).not.toBe(sha256Hex('trawlarrr'));
  });
});
