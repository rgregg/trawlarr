import type { FlowDefinition } from '@trawlarr/core';

export const SEND_WEBHOOK_PLUGIN_ID = 'trawlarr:sendWebhook';

export interface DestinationReference {
  nodeId: string;
  destination: string;
}

/**
 * Every alert destination a flow's Send Webhook nodes name, trimmed. A blank or non-string
 * input names nothing (the node skips itself at run time), so it is not a reference. The scan
 * is over `nodes`, not the graph: a node on an unreachable branch still ships in the definition
 * and can run after an edit, so it counts.
 */
export const findDestinationReferences = (definition: FlowDefinition): DestinationReference[] => {
  const found: DestinationReference[] = [];
  for (const node of definition.nodes) {
    if (node.pluginId !== SEND_WEBHOOK_PLUGIN_ID) continue;
    const raw = node.inputs.destination;
    const destination = typeof raw === 'string' ? raw.trim() : '';
    if (destination !== '') found.push({ nodeId: node.id, destination });
  }
  return found;
};
