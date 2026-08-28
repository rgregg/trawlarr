import { describe, expect, it } from 'vitest';
import { visibleRange } from './virtual.js';

describe('visibleRange', () => {
  it('shows only the rows the viewport can hold, plus overscan', () => {
    expect(
      visibleRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2 }),
    ).toEqual({ start: 0, end: 9 });
  });

  it('moves the window as the list scrolls', () => {
    expect(
      visibleRange({
        scrollTop: 400,
        viewportHeight: 100,
        rowHeight: 20,
        count: 1000,
        overscan: 2,
      }),
    ).toEqual({ start: 18, end: 27 });
  });

  // scrollTop 19_800 never reaches the count clamp under this formula — the
  // window still fits inside 1000 rows at that offset. 19_900 does: this is
  // the case that actually exercises "never runs past the end of the list".
  it('never runs past the end of the list', () => {
    expect(
      visibleRange({
        scrollTop: 19_900,
        viewportHeight: 100,
        rowHeight: 20,
        count: 1000,
        overscan: 2,
      }),
    ).toEqual({ start: 993, end: 1000 });
  });

  it('handles an empty list without producing a negative range', () => {
    expect(visibleRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 20, count: 0 })).toEqual({
      start: 0,
      end: 0,
    });
  });
});
