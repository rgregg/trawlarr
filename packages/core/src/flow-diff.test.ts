import { describe, expect, it } from 'vitest';
import { diffFlowDefinitions, isEmptyDiff } from './flow-diff.js';
import { flowDefinitionHash } from './signature.js';

const node = (
  id: string,
  pluginId: string,
  inputs: Record<string, unknown> = {},
  pluginVersion = '1.0.0',
) => ({
  id,
  pluginId,
  pluginVersion,
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

  it('guards edgeKey against dropping outputNumber: same from/to node, only the output number differs, must be reported as a real edge change', () => {
    // This is the muxqueue defect shape: check -> muxqueue exists on BOTH
    // sides, and only the output number says whether it is wired to the
    // already-correct branch or the encode branch. An edgeKey that keys off
    // (fromNodeId, toNodeId) alone would see these as the same edge and
    // report no change at all -- silently losing the one property this
    // feature exists to catch.
    const before = {
      nodes: [],
      edges: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' }],
    };
    const after = {
      nodes: [],
      edges: [{ fromNodeId: 'check', outputNumber: 2, toNodeId: 'muxqueue' }],
    };

    const diff = diffFlowDefinitions(before, after);
    expect(diff.edgesRemoved).toEqual([
      { fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' },
    ]);
    expect(diff.edgesAdded).toEqual([
      { fromNodeId: 'check', outputNumber: 2, toNodeId: 'muxqueue' },
    ]);
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

  it('reports a plugin version bump, naming the versions', () => {
    // The hash covers pluginVersion, so this publish re-queues the library.
    // A diff that called it identical would be lying on the one screen whose
    // job is saying what changed.
    const before = { nodes: [node('n', 'tdarr:encode', {}, '1.0.0')], edges: [] };
    const after = { nodes: [node('n', 'tdarr:encode', {}, '2.0.0')], edges: [] };

    expect(diffFlowDefinitions(before, after).nodePluginChanged).toEqual([
      { nodeId: 'n', from: 'tdarr:encode@1.0.0', to: 'tdarr:encode@2.0.0' },
    ]);
  });

  it('leaves the version out when only the plugin id moved', () => {
    const before = { nodes: [node('n', 'tdarr:a')], edges: [] };
    const after = { nodes: [node('n', 'tdarr:b')], edges: [] };

    expect(diffFlowDefinitions(before, after).nodePluginChanged).toEqual([
      { nodeId: 'n', from: 'tdarr:a', to: 'tdarr:b' },
    ]);
  });

  it('distinguishes an input whose type changed, and quotes it so the reader can see why', () => {
    // `5` and `"5"` hash differently and re-queue the library; rendering both
    // as `5` would read as "changed from 5 to 5".
    const before = { nodes: [node('n', 'x', { crf: 5 })], edges: [] };
    const after = { nodes: [node('n', 'x', { crf: '5' })], edges: [] };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([
      { nodeId: 'n', key: 'crf', from: '5', to: '"5"' },
    ]);
  });

  it('still shows a string input unquoted when nothing about the type moved', () => {
    const before = { nodes: [node('n', 'x', { codec: 'h264' })], edges: [] };
    const after = { nodes: [node('n', 'x', { codec: 'hevc' })], edges: [] };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([
      { nodeId: 'n', key: 'codec', from: 'h264', to: 'hevc' },
    ]);
  });

  it('is empty exactly when the two definitions share a flow hash', () => {
    // The property the whole screen rests on: an empty diff is the UI's
    // licence to say "these versions are identical", and a differing hash is
    // what re-queued the library. Any pair where those two disagree is a
    // screen telling a user nothing changed about a publish that re-encoded
    // their library. Every field the hash covers needs a case here.
    const base = node('n', 'tdarr:encode', { codec: 'h264', crf: 20, fast: true }, '1.0.0');
    const variants: Array<{ what: string; nodes: ReturnType<typeof node>[] }> = [
      { what: 'unchanged', nodes: [base] },
      { what: 'pluginId', nodes: [node('n', 'tdarr:other', base.inputs, '1.0.0')] },
      { what: 'pluginVersion', nodes: [node('n', 'tdarr:encode', base.inputs, '2.0.0')] },
      { what: 'node id', nodes: [node('m', 'tdarr:encode', base.inputs, '1.0.0')] },
      {
        what: 'input value',
        nodes: [node('n', 'tdarr:encode', { ...base.inputs, codec: 'hevc' }, '1.0.0')],
      },
      {
        what: 'input type: number to string',
        nodes: [node('n', 'tdarr:encode', { ...base.inputs, crf: '20' }, '1.0.0')],
      },
      {
        what: 'input type: boolean to string',
        nodes: [node('n', 'tdarr:encode', { ...base.inputs, fast: 'true' }, '1.0.0')],
      },
      {
        what: 'input removed',
        nodes: [node('n', 'tdarr:encode', { codec: 'h264', crf: 20 }, '1.0.0')],
      },
      { what: 'node removed', nodes: [] },
    ];

    for (const a of variants) {
      for (const b of variants) {
        const from = { nodes: a.nodes, edges: [] };
        const to = { nodes: b.nodes, edges: [] };
        const sameHash = flowDefinitionHash(from) === flowDefinitionHash(to);
        expect(
          isEmptyDiff(diffFlowDefinitions(from, to)),
          `${a.what} vs ${b.what}: diff emptiness must match hash equality`,
        ).toBe(sameHash);
      }
    }
  });
});
