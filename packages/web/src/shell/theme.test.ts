import { describe, expect, it } from 'vitest';

import { effectiveTheme, nextThemeChoice, readThemeChoice, themeLabel } from './theme.js';

describe('readThemeChoice', () => {
  it('accepts the three stored values', () => {
    expect(readThemeChoice('light')).toBe('light');
    expect(readThemeChoice('dark')).toBe('dark');
    expect(readThemeChoice('system')).toBe('system');
  });

  // A value from a future version, or one another app on this origin wrote,
  // must not be able to stop the app rendering.
  it('falls back to system for anything else', () => {
    expect(readThemeChoice(null)).toBe('system');
    expect(readThemeChoice('')).toBe('system');
    expect(readThemeChoice('DARK')).toBe('system');
    expect(readThemeChoice('{"theme":"dark"}')).toBe('system');
  });
});

describe('nextThemeChoice', () => {
  // The property that matters, and the reason the cycle is ordered the way
  // it is: the FIRST click — the one from the untouched default, which is
  // the only click most people ever make — always changes what is on
  // screen. A control whose first press appears to do nothing reads as
  // broken.
  //
  // It cannot hold for every step: three states over two appearances means
  // two of them necessarily look alike, and the step back to `system` is
  // the one that pays for it. That step is still legible, because the
  // button's icon and label change even when the colours do not.
  it('always changes the visible theme on the first click', () => {
    for (const systemPrefersDark of [true, false]) {
      const next = nextThemeChoice('system', systemPrefersDark);
      expect(effectiveTheme(next, systemPrefersDark)).not.toBe(
        effectiveTheme('system', systemPrefersDark),
      );
    }
  });

  it('returns to system after both explicit states', () => {
    // On a dark system: system -> light -> dark -> system.
    expect(nextThemeChoice('system', true)).toBe('light');
    expect(nextThemeChoice('light', true)).toBe('dark');
    expect(nextThemeChoice('dark', true)).toBe('system');

    // On a light system: system -> dark -> light -> system.
    expect(nextThemeChoice('system', false)).toBe('dark');
    expect(nextThemeChoice('dark', false)).toBe('light');
    expect(nextThemeChoice('light', false)).toBe('system');
  });

  it('visits every state within one full cycle', () => {
    for (const systemPrefersDark of [true, false]) {
      let choice: ReturnType<typeof nextThemeChoice> = 'system';
      const seen = new Set<string>([choice]);
      for (let step = 0; step < 3; step += 1) {
        choice = nextThemeChoice(choice, systemPrefersDark);
        seen.add(choice);
      }
      expect(seen).toEqual(new Set(['system', 'light', 'dark']));
      expect(choice).toBe('system');
    }
  });
});

describe('effectiveTheme', () => {
  it('resolves system against the media query and ignores it otherwise', () => {
    expect(effectiveTheme('system', true)).toBe('dark');
    expect(effectiveTheme('system', false)).toBe('light');
    expect(effectiveTheme('light', true)).toBe('light');
    expect(effectiveTheme('dark', false)).toBe('dark');
  });
});

describe('themeLabel', () => {
  it('names the choice rather than the resolved colour', () => {
    // "Matching your system" and "Dark" are different statements; a viewer
    // on a dark system who has not chosen anything has not chosen dark.
    expect(themeLabel('system')).toBe('Matching your system');
    expect(themeLabel('dark')).toBe('Dark');
    expect(themeLabel('light')).toBe('Light');
  });
});
