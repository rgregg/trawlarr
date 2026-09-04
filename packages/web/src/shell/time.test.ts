import { describe, expect, it } from 'vitest';

import { formatTimestamp, toIsoInstant } from './time.js';

/**
 * The bound these two functions exist to respect.
 *
 * ECMA-262 fixes the range of a `Date` at ±8.64e15 ms (±100,000,000 days),
 * and `toISOString()` does not degrade past it — it THROWS `RangeError:
 * Invalid time value`. Thrown during a React render, that unmounts the whole
 * tree, so a single unreadable timestamp took the entire application down.
 */
const MAX = 8.64e15;

describe('toIsoInstant', () => {
  it('returns the instant when it is one a Date can represent', () => {
    expect(toIsoInstant(Date.UTC(2026, 7, 27, 13, 45))).toBe('2026-08-27T13:45:00.000Z');
    expect(toIsoInstant(MAX)).toBe('+275760-09-13T00:00:00.000Z');
  });

  it('returns null instead of throwing, for every value that would', () => {
    expect(toIsoInstant(MAX + 1)).toBeNull();
    expect(toIsoInstant(-MAX - 1)).toBeNull();
    expect(toIsoInstant(1.8e19)).toBeNull();
    expect(toIsoInstant(Number.NaN)).toBeNull();
    expect(toIsoInstant(Number.POSITIVE_INFINITY)).toBeNull();
    // The API types these fields `number`, but a type is a claim about a
    // JSON payload rather than a guarantee about one.
    expect(toIsoInstant(undefined as unknown as number)).toBeNull();
  });

  it('treats zero and negative as unset rather than as 1970 and 1969', () => {
    expect(toIsoInstant(0)).toBeNull();
    expect(toIsoInstant(-1)).toBeNull();
  });

  // The property that matters more than any single case above: whatever it
  // is handed, it returns rather than throws. A caller renders the result.
  it('never throws, whatever it is handed', () => {
    const hostile = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      MAX,
      MAX + 1,
      -MAX,
      -MAX - 1,
      0,
      -0,
      1.5,
      undefined as unknown as number,
      null as unknown as number,
      'nonsense' as unknown as number,
      {} as unknown as number,
    ];
    for (const value of hostile) {
      expect(() => toIsoInstant(value)).not.toThrow();
    }
  });
});

describe('formatTimestamp', () => {
  it('renders the whole instant, for screens with room for one', () => {
    expect(formatTimestamp(Date.UTC(2026, 7, 27, 13, 45))).toBe('2026-08-27T13:45:00.000Z');
  });

  it('says nothing, rather than throwing, for a timestamp that is not one', () => {
    expect(formatTimestamp(MAX + 1)).toBe('—');
    expect(formatTimestamp(Number.NaN)).toBe('—');
    expect(formatTimestamp(0)).toBe('—');
  });
});
