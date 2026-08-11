import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Write a CommonJS plugin to a throwaway directory and return its path. */
export const writePluginFile = (code: string, filename = 'index.js'): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-plugin-'));
  const abs = join(dir, filename);
  writeFileSync(abs, code, 'utf8');
  return abs;
};

/** A minimal plugin that routes to a fixed output number. */
export const simplePluginCode = (outputNumber = 1): string => `
const details = () => ({
  name: 'Test Plugin',
  description: 'fixture',
  style: { borderColor: '#000000' },
  tags: 'test',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'out 1' }, { number: 2, tooltip: 'out 2' }],
  requiresVersion: '2.11.01',
});

const plugin = (args) => ({
  outputNumber: ${outputNumber},
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});

module.exports = { details, plugin };
`;
