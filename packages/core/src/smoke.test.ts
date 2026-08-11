import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from './index.js';

describe('toolchain', () => {
  it('resolves the core package barrel', () => {
    expect(CORE_PACKAGE).toBe('@trawlarr/core');
  });
});
