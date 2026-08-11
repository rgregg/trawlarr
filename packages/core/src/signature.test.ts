import { describe, expect, it } from 'vitest';
import { extractFacts } from './facts.js';
import { computeSignature, flowDefinitionHash } from './signature.js';
import type { FlowDefinition } from './flow.js';

const flow = (over: Partial<FlowDefinition> = {}): FlowDefinition => ({
  nodes: [
    { id: 'n1', pluginId: 'start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'n2',
      pluginId: 'setVideoEncoder',
      pluginVersion: '1.0.0',
      inputs: { encoder: 'hevc_nvenc', cq: '24' },
    },
  ],
  edges: [{ fromNodeId: 'n1', outputNumber: 1, toNodeId: 'n2' }],
  ...over,
});

const facts = extractFacts({
  probe: { format: { duration: '60' }, streams: [{ codec_type: 'video', codec_name: 'h264' }] },
  container: 'mkv',
  sizeBytes: 1000,
});

describe('flowDefinitionHash', () => {
  it('is stable for the same definition', () => {
    expect(flowDefinitionHash(flow())).toBe(flowDefinitionHash(flow()));
  });

  it('ignores node and edge ordering, which carries no meaning', () => {
    const reordered = flow({
      nodes: [...flow().nodes].reverse(),
    });
    expect(flowDefinitionHash(reordered)).toBe(flowDefinitionHash(flow()));
  });

  it('changes when a node input changes', () => {
    const edited = flow({
      nodes: [
        flow().nodes[0]!,
        { ...flow().nodes[1]!, inputs: { encoder: 'hevc_nvenc', cq: '20' } },
      ],
    });
    expect(flowDefinitionHash(edited)).not.toBe(flowDefinitionHash(flow()));
  });

  it('changes when a referenced plugin version changes', () => {
    const bumped = flow({
      nodes: [flow().nodes[0]!, { ...flow().nodes[1]!, pluginVersion: '1.1.0' }],
    });
    expect(flowDefinitionHash(bumped)).not.toBe(flowDefinitionHash(flow()));
  });

  it('changes when the graph is rewired', () => {
    const rewired = flow({ edges: [{ fromNodeId: 'n1', outputNumber: 2, toNodeId: 'n2' }] });
    expect(flowDefinitionHash(rewired)).not.toBe(flowDefinitionHash(flow()));
  });

  it('hashes every node, including ones no run would reach', () => {
    // This is the anti-regression test for the circular-signature bug:
    // an unreachable branch still contributes, because reachability is
    // per-file and cannot be known before running.
    const withOrphan = flow({
      nodes: [...flow().nodes, { id: 'n9', pluginId: 'x', pluginVersion: '1.0.0', inputs: {} }],
    });
    expect(flowDefinitionHash(withOrphan)).not.toBe(flowDefinitionHash(flow()));
  });
});

describe('computeSignature', () => {
  it('combines the flow hash and the file facts', () => {
    const h = flowDefinitionHash(flow());
    expect(computeSignature({ flowDefinitionHash: h, facts })).toBe(
      computeSignature({ flowDefinitionHash: h, facts }),
    );
  });

  it('changes when the flow changes, so a flow edit invalidates the file', () => {
    const a = computeSignature({ flowDefinitionHash: flowDefinitionHash(flow()), facts });
    const edited = flow({ edges: [] });
    const b = computeSignature({ flowDefinitionHash: flowDefinitionHash(edited), facts });
    expect(a).not.toBe(b);
  });

  it('changes when the file changes', () => {
    const h = flowDefinitionHash(flow());
    const other = extractFacts({ probe: {}, container: 'mp4', sizeBytes: 5 });
    expect(computeSignature({ flowDefinitionHash: h, facts })).not.toBe(
      computeSignature({ flowDefinitionHash: h, facts: other }),
    );
  });

  it('is computable with no run history, before anything executes', () => {
    expect(typeof computeSignature({ flowDefinitionHash: 'abc', facts })).toBe('string');
  });
});
