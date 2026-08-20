import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_BINDINGS } from '../packages/server/src/config/env-settings.js';

/** Variables the ENTRYPOINT or the container runtime reads, not the daemon. */
const RUNTIME_VARS = new Set([
  'PUID',
  'PGID',
  'TZ',
  'NVIDIA_VISIBLE_DEVICES',
  'NVIDIA_DRIVER_CAPABILITIES',
]);

const composeFiles = readdirSync('docker')
  .filter((name) => name.startsWith('compose') && name.endsWith('.yml'))
  .map((name) => join('docker', name));

describe('compose files', () => {
  it('are all discovered (a renamed file must not make this suite vacuous)', () => {
    expect(composeFiles).toContain('docker/compose.yml');
  });

  it.each(composeFiles)('%s sets only variables trawlarr reads', (file) => {
    const known = new Set([...ENV_BINDINGS.map((binding) => binding.name), ...RUNTIME_VARS]);
    const body = readFileSync(file, 'utf8');
    // The `environment:` block is a YAML list of `- NAME=value` entries.
    const declared = [...body.matchAll(/^\s+-\s+([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!);

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => !known.has(name))).toEqual([]);
  });

  it('publish the daemon port the image binds', () => {
    for (const file of composeFiles) {
      expect(readFileSync(file, 'utf8')).toContain('8265');
    }
  });
});
