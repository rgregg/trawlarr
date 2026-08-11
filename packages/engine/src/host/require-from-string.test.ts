import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { requireFromString } from './require-from-string.js';
import { writePluginFile } from '../../test/fixtures/make-plugin.js';

describe('requireFromString', () => {
  it('returns module.exports from CommonJS source', () => {
    const exports = requireFromString({
      code: `module.exports = { answer: 42 };`,
      filename: '/virtual/plugin.js',
    });
    expect(exports.answer).toBe(42);
  });

  it('supports the exports shorthand', () => {
    const exports = requireFromString({
      code: `exports.details = () => 'd';`,
      filename: '/virtual/plugin.js',
    });
    expect(typeof exports.details).toBe('function');
  });

  it('lets a plugin require Node builtins, which real plugins do', () => {
    const exports = requireFromString({
      code: `
        const path = require('node:path');
        const cp = require('child_process');
        module.exports = { joined: path.join('a', 'b'), hasSpawn: typeof cp.spawn };
      `,
      filename: '/virtual/plugin.js',
    });
    expect(exports.joined).toBe(join('a', 'b'));
    expect(exports.hasSpawn).toBe('function');
  });

  it('resolves relative requires against the plugin file', () => {
    const abs = writePluginFile(`module.exports = require('./helper.js').value;`);
    writeFileSync(abs.replace('index.js', 'helper.js'), `module.exports = { value: 7 };`, 'utf8');
    expect(
      requireFromString({ code: `module.exports = require('./helper.js').value;`, filename: abs }),
    ).toBe(7);
  });

  it('exposes __filename and __dirname', () => {
    const exports = requireFromString({
      code: `module.exports = { f: __filename, d: __dirname };`,
      filename: '/virtual/nested/plugin.js',
    });
    expect(exports.f).toBe('/virtual/nested/plugin.js');
    expect(exports.d).toBe('/virtual/nested');
  });

  it('compiles fresh each time, so two loads do not share state', () => {
    const code = `let calls = 0; module.exports = { bump: () => ++calls };`;
    const a = requireFromString({ code, filename: '/virtual/p.js' }) as {
      bump: () => number;
    };
    const b = requireFromString({ code, filename: '/virtual/p.js' }) as {
      bump: () => number;
    };
    expect(a.bump()).toBe(1);
    expect(b.bump()).toBe(1);
  });

  it('propagates a syntax error with the filename attached', () => {
    expect(() =>
      requireFromString({ code: `module.exports = {`, filename: '/virtual/broken.js' }),
    ).toThrow();
  });
});
