import { describe, expect, it } from 'vitest';
import { toGraphRows } from './flow-graph-model.js';

const definition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start' },
    { id: 'check', pluginId: 'tdarr:checkVideoCodec' },
    { id: 'encoder', pluginId: 'tdarr:ffmpegCommandSetVideoEncoder' },
    { id: 'muxqueue', pluginId: 'tdarr:ffmpegCommandCustomArguments' },
    { id: 'audio', pluginId: 'tdarr:ffmpegCommandEnsureAudioStream', inputs: { language: 'eng' } },
  ],
  edges: [
    { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
    { fromNodeId: 'check', outputNumber: 1, toNodeId: 'audio' },
    { fromNodeId: 'check', outputNumber: 2, toNodeId: 'encoder' },
    { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'muxqueue' },
    { fromNodeId: 'muxqueue', outputNumber: 1, toNodeId: 'audio' },
  ],
};

describe('toGraphRows', () => {
  it('walks from start and indents each branch', () => {
    const rows = toGraphRows(definition);
    expect(rows.map((r) => r.nodeId)).toEqual(['start', 'check', 'audio', 'encoder', 'muxqueue']);
    expect(rows.find((r) => r.nodeId === 'encoder')?.depth).toBe(2);
  });

  it('labels which branch a node hangs off — the muxqueue bug was exactly this', () => {
    const rows = toGraphRows(definition);
    expect(rows.find((r) => r.nodeId === 'encoder')?.branchLabel).toBe('output 2');
    expect(rows.find((r) => r.nodeId === 'audio')?.branchLabel).toBe('output 1');
  });

  it('shows a node visited twice only once', () => {
    expect(toGraphRows(definition).filter((r) => r.nodeId === 'audio')).toHaveLength(1);
  });

  it('renders inputs as readable pairs', () => {
    expect(toGraphRows(definition).find((r) => r.nodeId === 'audio')?.inputs).toEqual([
      { key: 'language', value: 'eng' },
    ]);
  });

  it('survives a definition with no start node rather than throwing', () => {
    expect(toGraphRows({ nodes: [], edges: [] })).toEqual([]);
  });
});
