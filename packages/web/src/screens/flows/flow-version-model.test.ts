import { describe, expect, it } from 'vitest';
import { formatWhen, toDiffLines, toVersionRows } from './flow-version-model.js';

const v = (id: string, hash: string, note: string, createdAt: number, isCurrent = false) => ({
  id,
  flowId: 'f1',
  definitionHash: hash,
  note,
  createdAt,
  isCurrent,
});

describe('toVersionRows', () => {
  it('shortens the hash for display while keeping the whole one', () => {
    const [row] = toVersionRows([v('a', '17dce8bd5e3482bf', 'x', 1000)], 1000);
    expect(row!.shortHash).toBe('17dce8bd');
    expect(row!.hash).toBe('17dce8bd5e3482bf');
  });

  it('marks the current version', () => {
    const rows = toVersionRows([v('a', 'h1', '', 2000, true), v('b', 'h2', '', 1000)], 2000);
    expect(rows.map((r) => r.isCurrent)).toEqual([true, false]);
  });

  it('describes an empty note as the publish it was, not as blank', () => {
    const [row] = toVersionRows([v('a', 'h', '', 1000)], 1000);
    expect(row!.note).toBe('Published');
  });

  it('keeps a real note as written', () => {
    const [row] = toVersionRows([v('a', 'h', 'Fixed the muxqueue node', 1000)], 1000);
    expect(row!.note).toBe('Fixed the muxqueue node');
  });
});

describe('formatWhen', () => {
  it('reads "Today" for a version published on the same UTC day as now', () => {
    const createdAt = Date.parse('2026-08-29T03:15:00.000Z');
    const nowMs = Date.parse('2026-08-29T20:00:00.000Z');
    expect(formatWhen(createdAt, nowMs)).toBe('Today, 03:15 UTC');
  });

  it('falls back to a plain date on a different day', () => {
    const createdAt = Date.parse('2026-08-27T03:15:00.000Z');
    const nowMs = Date.parse('2026-08-29T20:00:00.000Z');
    expect(formatWhen(createdAt, nowMs)).toBe('2026-08-27');
  });

  it('renders a missing timestamp as a dash rather than "Invalid Date"', () => {
    expect(formatWhen(0, 1000)).toBe('—');
  });
});

describe('toDiffLines', () => {
  it('renders a re-pointed edge as a removal and an addition', () => {
    const lines = toDiffLines({
      nodesAdded: [],
      nodesRemoved: [],
      nodePluginChanged: [],
      inputsChanged: [],
      edgesRemoved: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' }],
      edgesAdded: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'audio' }],
    });

    expect(lines).toEqual([
      { kind: 'edge-removed', text: 'check output 1 → muxqueue' },
      { kind: 'edge-added', text: 'check output 1 → audio' },
    ]);
  });

  it('renders an input change with both values', () => {
    const lines = toDiffLines({
      nodesAdded: [],
      nodesRemoved: [],
      nodePluginChanged: [],
      inputsChanged: [{ nodeId: 'lang', key: 'keepLanguages', from: 'eng', to: 'eng,kor' }],
      edgesAdded: [],
      edgesRemoved: [],
    });

    expect(lines).toEqual([{ kind: 'input-changed', text: 'lang.keepLanguages: eng → eng,kor' }]);
  });

  it('names an absent value rather than printing "null"', () => {
    const lines = toDiffLines({
      nodesAdded: [],
      nodesRemoved: [],
      nodePluginChanged: [],
      inputsChanged: [{ nodeId: 'e', key: 'quality', from: null, to: '23' }],
      edgesAdded: [],
      edgesRemoved: [],
    });

    expect(lines[0]!.text).toBe('e.quality: not set → 23');
  });

  it('returns nothing for two identical definitions', () => {
    expect(
      toDiffLines({
        nodesAdded: [],
        nodesRemoved: [],
        nodePluginChanged: [],
        inputsChanged: [],
        edgesAdded: [],
        edgesRemoved: [],
      }),
    ).toEqual([]);
  });

  it('renders node removals and additions by id', () => {
    const lines = toDiffLines({
      nodesAdded: ['audio'],
      nodesRemoved: ['muxqueue'],
      nodePluginChanged: [],
      inputsChanged: [],
      edgesAdded: [],
      edgesRemoved: [],
    });

    expect(lines).toEqual([
      { kind: 'node-removed', text: 'muxqueue removed' },
      { kind: 'node-added', text: 'audio added' },
    ]);
  });

  it('renders a plugin change with both plugin ids', () => {
    const lines = toDiffLines({
      nodesAdded: [],
      nodesRemoved: [],
      nodePluginChanged: [{ nodeId: 'check', from: 'codecCheck', to: 'codecCheckV2' }],
      inputsChanged: [],
      edgesAdded: [],
      edgesRemoved: [],
    });

    expect(lines).toEqual([{ kind: 'plugin-changed', text: 'check: codecCheck → codecCheckV2' }]);
  });

  it('orders lines nodes removed, nodes added, plugin changes, input changes, edges removed, edges added', () => {
    const lines = toDiffLines({
      nodesAdded: ['newNode'],
      nodesRemoved: ['oldNode'],
      nodePluginChanged: [{ nodeId: 'check', from: 'a', to: 'b' }],
      inputsChanged: [{ nodeId: 'lang', key: 'k', from: '1', to: '2' }],
      edgesAdded: [{ fromNodeId: 'x', outputNumber: 1, toNodeId: 'y' }],
      edgesRemoved: [{ fromNodeId: 'x', outputNumber: 1, toNodeId: 'z' }],
    });

    expect(lines.map((line) => line.kind)).toEqual([
      'node-removed',
      'node-added',
      'plugin-changed',
      'input-changed',
      'edge-removed',
      'edge-added',
    ]);
  });
});
