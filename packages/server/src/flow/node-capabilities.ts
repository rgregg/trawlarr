import type { FlowNodeCapabilities, FlowNodeCapabilityResolver } from '@trawlarr/core';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import { createPluginLoader, type PluginLoader } from '@trawlarr/engine';

/**
 * Resolves a flow node's plugin to what it declares about itself, the same two
 * ways `runJob` resolves one to run it: a first-party id from
 * `FIRST_PARTY_PLUGINS`, otherwise the plugin id treated as a path and loaded.
 * Resolving it any other way would let a flow validate against a declaration
 * the executor never reads.
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
}): FlowNodeCapabilityResolver => {
  const loader = options?.loader ?? createPluginLoader();

  return (node) => {
    const firstParty = FIRST_PARTY_PLUGINS[node.pluginId];
    if (firstParty !== undefined) {
      const details = firstParty.module.details();
      return capabilitiesFrom(details.outputs, details.isStartPlugin);
    }
    try {
      const loaded = loader.load(node.pluginId);
      return capabilitiesFrom(loaded.details.outputs, loaded.details.isStartPlugin);
    } catch {
      return null;
    }
  };
};

const capabilitiesFrom = (
  outputs: { number: number }[],
  isStartPlugin: boolean,
): FlowNodeCapabilities => ({
  outputNumbers: outputs.map((output) => output.number),
  isStartPlugin: isStartPlugin === true,
});
