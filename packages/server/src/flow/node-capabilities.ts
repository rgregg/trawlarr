import type { FlowNodeCapabilities, FlowNodeCapabilityResolver } from '@trawlarr/core';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import { createPluginLoader, type PluginLoader } from '@trawlarr/engine';
import type { PluginRegistry } from '../plugins/registry.js';

/**
 * Resolves a flow node's plugin to what it declares about itself, the same
 * three ways `runPayload` resolves one to run it: a first-party id from
 * `FIRST_PARTY_PLUGINS`, then an INSTALLED id through the registry, otherwise
 * the plugin id treated as a path and loaded. Resolving it any other way
 * would let a flow validate against a declaration the executor never reads.
 *
 * The installed branch reads the plugin's REAL `details()` by loading the file
 * the registry named, not the details cached on its row: validation rejects an
 * output number the plugin does not declare, so a stale copy would reject a
 * legal flow (or accept an illegal one) the moment a source is re-synced.
 *
 * Without a registry — the default, and every caller that has no database —
 * an installed id simply falls through to the path attempt and resolves to
 * `null`, exactly as it did before this branch existed.
 *
 * A plugin that cannot be loaded here resolves to `null`, which the validator
 * treats as "unknown", not "wrong" — see `FlowNodeCapabilityResolver`. Loading
 * a third-party plugin runs its module body (that is what `details()` costs),
 * and it can throw; that is caught here and reported as unknown rather than
 * failing the whole flow, because a plugin too broken to load already fails
 * loudly on the first file that reaches it.
 */
export const createNodeCapabilityResolver = (options?: {
  loader?: PluginLoader;
  registry?: PluginRegistry;
}): FlowNodeCapabilityResolver => {
  const loader = options?.loader ?? createPluginLoader();

  return (node) => {
    const firstParty = FIRST_PARTY_PLUGINS[node.pluginId];
    if (firstParty !== undefined) {
      const details = firstParty.module.details();
      return capabilitiesFrom(details.outputs, details.isStartPlugin, details.pType);
    }
    const installed = options?.registry?.resolveAbsPath(node.pluginId) ?? null;
    if (installed !== null) {
      try {
        const loaded = loader.load(installed);
        return capabilitiesFrom(
          loaded.details.outputs,
          loaded.details.isStartPlugin,
          loaded.details.pType,
        );
      } catch {
        return null;
      }
    }
    try {
      const loaded = loader.load(node.pluginId);
      return capabilitiesFrom(
        loaded.details.outputs,
        loaded.details.isStartPlugin,
        loaded.details.pType,
      );
    } catch {
      return null;
    }
  };
};

const capabilitiesFrom = (
  outputs: { number: number }[],
  isStartPlugin: boolean,
  pType: string,
): FlowNodeCapabilities => ({
  outputNumbers: outputs.map((output) => output.number),
  isStartPlugin: isStartPlugin === true,
  isErrorHandler: pType === 'onFlowError',
});
