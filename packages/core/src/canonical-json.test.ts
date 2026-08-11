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
});

describe('sha256Hex', () => {
  it('produces a stable 64-character digest', () => {
    const digest = sha256Hex('trawlarr');
    expect(digest).toHaveLength(64);
    expect(digest).toBe(sha256Hex('trawlarr'));
    expect(digest).not.toBe(sha256Hex('trawlarrr'));
  });
});
