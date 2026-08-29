import { describe, expect, it } from 'vitest';
import { diffFlowDefinitions, isEmptyDiff } from './flow-diff.js';

const node = (id: string, pluginId: string, inputs: Record<string, unknown> = {}) => ({
  id,
  pluginId,
  pluginVersion: '1.0.0',
  inputs,
});

describe('diffFlowDefinitions', () => {
  it('reads a re-pointed branch as one edge removed and one added', () => {
    // The muxqueue defect exactly: the node hung off output 1, the branch for
    // files that are ALREADY correct, instead of the encode branch.
    const before = {
      nodes: [
        node('check', 'tdarr:checkVideoCodec'),
        node('muxqueue', 'tdarr:custom'),
        node('audio', 'tdarr:audio'),
      ],
      edges: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' }],
    };
    const after = {
      nodes: [
        node('check', 'tdarr:checkVideoCodec'),
        node('muxqueue', 'tdarr:custom'),
        node('audio', 'tdarr:audio'),
      ],
      edges: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'audio' }],
    };

    const diff = diffFlowDefinitions(before, after);

    expect(diff.edgesRemoved).toEqual([
      { fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' },
    ]);
    expect(diff.edgesAdded).toEqual([{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'audio' }]);
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.nodesRemoved).toEqual([]);
  });

  it('treats the same output number to a different node as a real change', () => {
    const before = { nodes: [], edges: [{ fromNodeId: 'a', outputNumber: 2, toNodeId: 'b' }] };
    const after = { nodes: [], edges: [{ fromNodeId: 'a', outputNumber: 2, toNodeId: 'c' }] };
    expect(diffFlowDefinitions(before, after).edgesAdded).toHaveLength(1);
  });

  it('reports a changed input with both values', () => {
    const before = { nodes: [node('lang', 'tdarr:remove', { keepLanguages: 'eng' })], edges: [] };
    const after = {
      nodes: [node('lang', 'tdarr:remove', { keepLanguages: 'eng,kor,swe' })],
      edges: [],
    };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([
      { nodeId: 'lang', key: 'keepLanguages', from: 'eng', to: 'eng,kor,swe' },
    ]);
  });

  it('reports an input that appeared or disappeared as null on one side', () => {
    const before = { nodes: [node('e', 'tdarr:enc', {})], edges: [] };
    const after = { nodes: [node('e', 'tdarr:enc', { quality: '23' })], edges: [] };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([
      { nodeId: 'e', key: 'quality', from: null, to: '23' },
    ]);
  });

  it('reports a node id reused for a different plugin', () => {
    const before = { nodes: [node('x', 'tdarr:one')], edges: [] };
    const after = { nodes: [node('x', 'tdarr:two')], edges: [] };

    expect(diffFlowDefinitions(before, after).nodePluginChanged).toEqual([
      { nodeId: 'x', from: 'tdarr:one', to: 'tdarr:two' },
    ]);
  });

  it('is blind to node and edge ORDER', () => {
    const a = {
      nodes: [node('p', 'x'), node('q', 'y')],
      edges: [
        { fromNodeId: 'p', outputNumber: 1, toNodeId: 'q' },
        { fromNodeId: 'q', outputNumber: 1, toNodeId: 'p' },
      ],
    };
    const b = {
      nodes: [node('q', 'y'), node('p', 'x')],
      edges: [
        { fromNodeId: 'q', outputNumber: 1, toNodeId: 'p' },
        { fromNodeId: 'p', outputNumber: 1, toNodeId: 'q' },
      ],
    };

    expect(isEmptyDiff(diffFlowDefinitions(a, b))).toBe(true);
  });

  it('reports an added node and the edge that reaches it', () => {
    const before = { nodes: [node('a', 'x')], edges: [] };
    const after = {
      nodes: [node('a', 'x'), node('b', 'y')],
      edges: [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
    };

    const diff = diffFlowDefinitions(before, after);
    expect(diff.nodesAdded).toEqual(['b']);
    expect(diff.edgesAdded).toHaveLength(1);
  });

  it('does not report inputs for a node that was added or removed outright', () => {
    // Its inputs are not a CHANGE; the whole node is.
    const before = { nodes: [], edges: [] };
    const after = { nodes: [node('n', 'x', { a: '1' })], edges: [] };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([]);
  });

  it('compares non-string input values by their JSON form', () => {
    const before = { nodes: [node('n', 'x', { flag: true })], edges: [] };
    const after = { nodes: [node('n', 'x', { flag: false })], edges: [] };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([
      { nodeId: 'n', key: 'flag', from: 'true', to: 'false' },
    ]);
  });
});
