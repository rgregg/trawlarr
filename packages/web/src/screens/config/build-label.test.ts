import { describe, expect, it } from 'vitest';
import { buildLabel } from './build-label.js';

describe('buildLabel', () => {
  it('shows the short commit beside the version', () => {
    expect(
      buildLabel({ version: '0.1.0', commit: '40e7cc102c218506a6867cb6e50e246899d288d6' }),
    ).toBe('0.1.0 (40e7cc1)');
  });

  it('shows the version alone when the build recorded no commit', () => {
    expect(buildLabel({ version: '0.1.0', commit: null })).toBe('0.1.0');
  });
});
