import type { LoadedPlugin } from '../host/loader.js';

export type SideEffectClass = 'inert' | 'engine-controlled' | 'unknown';

/**
 * Classification keys on the literal `trawlarr:*` plugin id assigned when first-party plugins
 * are registered in-process. Plugin ids produced by `createPluginLoader` (path hashes, 16 hex
 * chars) will correctly never match these allowlists and classify as `unknown`. First-party
 * plugins must NOT be routed through `createPluginLoader`, or the dry run will stop at every
 * node.
 */
/**
 * These list only nodes that actually SHIP (see FIRST_PARTY_PLUGINS in
 * @trawlarr/plugins-core). Add an id here in the same change that adds the
 * node, never ahead of it: an id listed for a node that does not exist yet
 * classifies an unimplemented node as vouched-for, when the correct answer is
 * `unknown` — which is what makes a dry run stop rather than quietly pretend.
 */
/** First-party nodes that only read and decide. */
export const FIRST_PARTY_INERT = new Set([
  'trawlarr:start',
  'trawlarr:checkVideoCodec',
  'trawlarr:beginCommand',
  'trawlarr:setVideoEncoder',
]);

/** First-party nodes whose effects the engine performs, so it can withhold them. */
export const FIRST_PARTY_ENGINE_CONTROLLED = new Set([
  'trawlarr:execute',
  'trawlarr:verifyOutput',
  'trawlarr:replaceOriginal',
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
