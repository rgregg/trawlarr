import { describe, expect, it } from 'vitest';

import { attentionBadge, attentionLabel } from './attention.js';

describe('attentionBadge', () => {
  it('prints the count while it is small enough to read', () => {
    expect(attentionBadge(1)).toBe('1');
    expect(attentionBadge(42)).toBe('42');
    expect(attentionBadge(99)).toBe('99');
  });

  // Nobody triages differently at 214 than at 99, and three digits in a nav
  // badge are unreadable at that size. The exact figure is one click away.
  it('stops counting past the cap', () => {
    expect(attentionBadge(100)).toBe('99+');
    expect(attentionBadge(4625)).toBe('99+');
  });
});

describe('attentionLabel', () => {
  /**
   * The badge is `aria-hidden` and this replaces the whole link's label, so
   * the sentence has to carry what the number MEANS. Appending a bare "3" to
   * "Diagnose" announces as "Diagnose 3", which could be a shortcut key or a
   * position in the nav.
   */
  it('says what the number counts, not just the number', () => {
    expect(attentionLabel(3)).toBe('Diagnose, 3 files need attention');
  });

  it('agrees with itself about one file', () => {
    expect(attentionLabel(1)).toBe('Diagnose, 1 file needs attention');
  });

  /**
   * `undefined` rather than "Diagnose, 0 files need attention": with nothing
   * wrong there is no badge, so overriding the label would make the tab
   * announce a count that is not on screen. The plain link text is right.
   */
  it('leaves the link to speak for itself when there is nothing to say', () => {
    expect(attentionLabel(0)).toBeUndefined();
    expect(attentionLabel(null)).toBeUndefined();
  });

  // Unlike the badge, the spoken label is not capped — a screen reader is
  // reading a sentence, not squinting at a 16px circle.
  it('does not cap the spoken count', () => {
    expect(attentionLabel(214)).toBe('Diagnose, 214 files need attention');
  });
});
