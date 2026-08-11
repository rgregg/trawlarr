import type { LoadedPlugin } from '../host/loader.js';

export type SideEffectClass = 'inert' | 'engine-controlled' | 'unknown';

/**
 * Classification keys on the literal `trawlarr:*` plugin id assigned when first-party plugins
 * are registered in-process. Plugin ids produced by `createPluginLoader` (path hashes, 16 hex
 * chars) will correctly never match these allowlists and classify as `unknown`. First-party
 * plugins must NOT be routed through `createPluginLoader`, or the dry run will stop at every
 * node.
 */
/** First-party nodes that only read and decide. */
export const FIRST_PARTY_INERT = new Set([
  'trawlarr:start',
  'trawlarr:checkVideoCodec',
  'trawlarr:checkResolution',
  'trawlarr:checkFileSize',
  'trawlarr:beginCommand',
  'trawlarr:setVideoEncoder',
  'trawlarr:setAudioCodec',
]);

/** First-party nodes whose effects the engine performs, so it can withhold them. */
export const FIRST_PARTY_ENGINE_CONTROLLED = new Set([
  'trawlarr:execute',
  'trawlarr:verifyOutput',
  'trawlarr:replaceOriginal',
  'trawlarr:moveFile',
]);

/**
 * Can the engine guarantee this node performs no side effect during a dry run?
 *
 * Only for nodes we wrote. A third-party plugin can require('child_process')
 * directly, so "unknown" is the honest answer for everything else — and it is
 * where a dry run stops.
 */
export const classifySideEffects = (plugin: LoadedPlugin): SideEffectClass => {
  if (FIRST_PARTY_INERT.has(plugin.id)) return 'inert';
  if (FIRST_PARTY_ENGINE_CONTROLLED.has(plugin.id)) return 'engine-controlled';
  return 'unknown';
};
