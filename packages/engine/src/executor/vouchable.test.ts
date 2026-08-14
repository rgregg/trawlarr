import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import { classifySideEffects } from './vouchable.js';

// This test lives here rather than in plugins-core's own test suite because
// plugins-core must not depend on @trawlarr/engine (engine depends on
// plugins-core, and a dependency the other way would be circular). engine
// already depends on plugins-core at runtime, so this is the one direction
// that can import both `classifySideEffects` and `FIRST_PARTY_PLUGINS`
// without creating a circular project reference.
describe('side-effect classification', () => {
  it('classifies both new nodes as engine-controlled so a dry run can render them inert', () => {
    for (const id of ['trawlarr:verifyOutput', 'trawlarr:replaceOriginal']) {
      const entry = FIRST_PARTY_PLUGINS[id]!;
      expect(
        classifySideEffects({
          id: entry.id,
          absPath: 'builtin',
          version: '1',
          details: entry.module.details(),
          module: entry.module,
        } as never),
      ).toBe('engine-controlled');
    }
  });
});
