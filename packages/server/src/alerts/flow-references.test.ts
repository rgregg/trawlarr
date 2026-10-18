import { describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { findDestinationReferences } from './flow-references.js';

const node = (id: string, pluginId: string, inputs: Record<string, unknown> = {}) => ({
  id,
  pluginId,
  pluginVersion: '1',
  inputs,
});

describe('findDestinationReferences', () => {
  it('finds Send Webhook nodes across a branching flow and ignores other plugins', () => {
    const def: FlowDefinition = {
      nodes: [
        node('s', 'trawlarr:start'),
        node('a', 'trawlarr:sendWebhook', { destination: 'ha' }),
        node('b', 'trawlarr:sendWebhook', { destination: ' ntfy ' }),
        node('c', 'trawlarr:writeToLog', { destination: 'nope' }),
      ],
      edges: [
        { fromNodeId: 's', outputNumber: 1, toNodeId: 'a' },
        { fromNodeId: 's', outputNumber: 2, toNodeId: 'b' },
        { fromNodeId: 'b', outputNumber: 1, toNodeId: 'c' },
      ],
    };
    expect(findDestinationReferences(def)).toEqual([
      { nodeId: 'a', destination: 'ha' },
      { nodeId: 'b', destination: 'ntfy' },
    ]);
  });

  it('treats a missing, blank or non-string destination as no reference', () => {
    const def: FlowDefinition = {
      nodes: [
        node('a', 'trawlarr:sendWebhook'),
        node('b', 'trawlarr:sendWebhook', { destination: '  ' }),
        node('c', 'trawlarr:sendWebhook', { destination: 4 }),
      ],
      edges: [],
    };
    expect(findDestinationReferences(def)).toEqual([]);
  });
});
