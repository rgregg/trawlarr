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

  it('shows a node visited twice only once, and names the branch that did not draw it', () => {
    // Drawing it twice would report a graph with more nodes than the flow
    // has — real flows rejoin. But drawing it once with NO mention of the
    // second inbound edge is how this screen would render the defect it
    // exists for: the muxqueue node sat on BOTH branches of a codec check,
    // and under the walk alone that reads as if it hung off output 1 only.
    const rows = toGraphRows(definition);
    const audio = rows.filter((r) => r.nodeId === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0]!.branchLabel).toBe('output 1');
    expect(audio[0]!.alsoReachedFrom).toEqual(['output 1 of muxqueue']);
  });

  it('names BOTH branches of a check that reach one node — the muxqueue shape itself', () => {
    const rows = toGraphRows({
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start' },
        { id: 'check', pluginId: 'tdarr:checkVideoCodec' },
        { id: 'muxqueue', pluginId: 'tdarr:ffmpegCommandCustomArguments' },
      ],
      edges: [
        { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
        { fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' },
        { fromNodeId: 'check', outputNumber: 2, toNodeId: 'muxqueue' },
      ],
    });
    const muxqueue = rows.find((r) => r.nodeId === 'muxqueue')!;
    expect(muxqueue.branchLabel).toBe('output 1');
    expect(muxqueue.alsoReachedFrom).toEqual(['output 2 of check']);
  });

  it('draws a node nothing reaches rather than silently omitting it', () => {
    // A node left behind by a deleted edge is in the flow and never runs.
    // A screen that exists to make a misplaced node visible must not be the
    // one thing that hides it.
    const rows = toGraphRows({
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start' },
        { id: 'orphan', pluginId: 'tdarr:ffmpegCommandCustomArguments' },
      ],
      edges: [],
    });
    expect(rows.map((r) => r.nodeId)).toEqual(['start', 'orphan']);
    expect(rows.find((r) => r.nodeId === 'orphan')!.unreachable).toBe(true);
    expect(rows.find((r) => r.nodeId === 'start')!.unreachable).toBe(false);
  });

  it('renders inputs as readable pairs', () => {
    expect(toGraphRows(definition).find((r) => r.nodeId === 'audio')?.inputs).toEqual([
      { key: 'language', value: 'eng' },
    ]);
  });

  it('returns nothing for a definition with no nodes at all', () => {
    expect(toGraphRows({ nodes: [], edges: [] })).toEqual([]);
  });

  it('still draws a definition with nodes but no start node — a full cycle', () => {
    // The doc comment used to promise `[]` here and the code has never done
    // that: it falls back to `nodes[0]`. Drawing is the intended behaviour —
    // a malformed flow is the case this screen exists for, and refusing to
    // draw it leaves the operator with the JSON they already could not read
    // — so the comment was corrected to the code, and both cases are pinned.
    const rows = toGraphRows({
      nodes: [
        { id: 'a', pluginId: 'p:a' },
        { id: 'b', pluginId: 'p:b' },
      ],
      edges: [
        { fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' },
        { fromNodeId: 'b', outputNumber: 1, toNodeId: 'a' },
      ],
    });
    expect(rows.map((r) => r.nodeId)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.unreachable)).toEqual([false, false]);
    // `a` is drawn as the fallback root, so the edge that DOES reach it is
    // named rather than lost.
    expect(rows[0]!.alsoReachedFrom).toEqual(['output 1 of b']);
  });
});
