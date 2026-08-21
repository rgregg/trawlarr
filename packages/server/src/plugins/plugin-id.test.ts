import { describe, expect, it } from 'vitest';
import {
  assertValidSourceSlug,
  formatPluginId,
  parsePluginId,
  PluginIdError,
  FIRST_PARTY_NAMESPACE,
} from './plugin-id.js';

describe('installed plugin ids', () => {
  it('formats as <source slug>:<plugin name>, matching the first-party shape', () => {
    expect(formatPluginId({ sourceSlug: 'tdarr', pluginName: 'ffmpegCommandSetContainer' })).toBe(
      'tdarr:ffmpegCommandSetContainer',
    );
  });

  it('round-trips', () => {
    const id = { sourceSlug: 'tdarr', pluginName: 'ffmpegCommandSetContainer' };
    expect(parsePluginId(formatPluginId(id))).toEqual(id);
  });

  it('refuses to parse a first-party id, so the namespace can never be shadowed', () => {
    // A source slugged "trawlarr" could otherwise install a plugin that
    // silently replaces a first-party node in every existing flow.
    expect(parsePluginId(`${FIRST_PARTY_NAMESPACE}:execute`)).toBeNull();
  });

  it('refuses an absolute path, which is how a community plugin is named today', () => {
    expect(parsePluginId('/media/plugins/thing/1.0.0/index.js')).toBeNull();
  });

  it('refuses a Windows path that happens to contain a colon', () => {
    expect(parsePluginId('C:\\plugins\\thing\\index.js')).toBeNull();
  });

  it('refuses an empty half', () => {
    expect(parsePluginId(':thing')).toBeNull();
    expect(parsePluginId('tdarr:')).toBeNull();
  });
});

describe('source slugs', () => {
  it('accepts lowercase alphanumerics and hyphens', () => {
    expect(() => assertValidSourceSlug('tdarr-community')).not.toThrow();
  });

  it('rejects the first-party namespace by name', () => {
    expect(() => assertValidSourceSlug(FIRST_PARTY_NAMESPACE)).toThrow(PluginIdError);
  });

  it('rejects a slug containing a colon, which would make ids ambiguous', () => {
    expect(() => assertValidSourceSlug('a:b')).toThrow(PluginIdError);
  });

  it('rejects uppercase, so two sources cannot differ only by case', () => {
    expect(() => assertValidSourceSlug('Tdarr')).toThrow(PluginIdError);
  });
});
