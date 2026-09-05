import { describe, expect, it } from 'vitest';
import type { FlowDefinition, FlowEdge, FlowNode } from '@trawlarr/core';
import {
  addPluginNode,
  autoLayout,
  canvasNodeWidth,
  connectNodes,
  definitionsEqual,
  deleteSelection,
  deleteCanvasSelection,
  fromCanvas,
  insertNodeOnEdge,
  nextNodeId,
  pushHistory,
  reachableNodeIds,
  redoHistory,
  settledLayout,
  startNodeId,
  toCanvas,
  undoHistory,
} from './flow-canvas-model.js';
import type { CanvasHistory, EditorPlugin } from './flow-canvas-model.js';

const plugin = (id: string, outputs = [1], start = false): EditorPlugin => ({
  id,
  name: id,
  description: `Description of ${id}`,
  tags: 'test',
  version: '2.0',
  enabled: true,
  isStartPlugin: start,
  source: 'core',
  details: {
    name: id,
    description: '',
    tags: 'test',
    style: { borderColor: 'red' },
    isStartPlugin: start,
    pType: start ? 'start' : '',
    sidebarPosition: 0,
    icon: 'fa-test',
    inputs: [
      {
        name: 'enabled',
        label: 'Enabled',
        type: 'boolean',
        defaultValue: 'false',
        tooltip: '',
        inputUI: { type: 'switch' },
      },
    ],
    outputs: outputs.map((number) => ({ number, tooltip: `Meaning ${number}` })),
    requiresVersion: '',
  },
});
const plugins = [plugin('start', [1], true), plugin('step'), plugin('branch', [1, 2])];
const node = (id: string, pluginId = 'step'): FlowNode => ({
  id,
  pluginId,
  pluginVersion: '1.0',
  inputs: { existing: { nested: [true, 'value'] } },
});
const edge = (fromNodeId: string, toNodeId: string, outputNumber = 1): FlowEdge => ({
  fromNodeId,
  toNodeId,
  outputNumber,
});
const chain = (): FlowDefinition => ({
  nodes: [node('s', 'start'), node('a'), node('b'), node('c')],
  edges: [edge('s', 'a'), edge('a', 'b'), edge('b', 'c')],
});

describe('canvas translation and layout', () => {
  it('treats On Error as a separate entry while preserving Start protection and saved layout', () => {
    const onError = plugin('on-error');
    onError.details.pType = 'onFlowError';
    const available = [...plugins, onError];
    const definition = {
      nodes: [node('s', 'start'), node('e', 'on-error'), node('recover'), node('orphan')],
      edges: [edge('e', 'recover')],
    };
    const projected = toCanvas(definition, available, [], { e: { x: 800, y: 900 } });
    const handler = projected.nodes.find((item) => item.id === 'e')!;
    expect(handler.position).toEqual({ x: 800, y: 900 });
    expect(handler.data.errorEntry).toBe(true);
    expect(handler.data.protectedStart).toBe(false);
    expect(handler.deletable).toBe(true);
    expect(projected.nodes.find((item) => item.id === 's')!.deletable).toBe(false);
    expect(projected.nodes.filter((item) => item.data.unreachable).map((item) => item.id)).toEqual([
      'orphan',
    ]);
    const layout = autoLayout(definition, available);
    expect(layout.e!.y).toBe(layout.s!.y);
    expect(layout.recover!.y).toBeGreaterThan(layout.e!.y);
    expect(addPluginNode(definition, onError, 'second-error', available)).toBe(definition);
  });

  it('uses compact 200px boxes and lays a chain out from top to bottom', () => {
    const definition = chain();
    const layout = autoLayout(definition, plugins);
    expect(definition.nodes.map((item) => layout[item.id])).toEqual([
      { x: 40, y: 40 },
      { x: 40, y: 240 },
      { x: 40, y: 440 },
      { x: 40, y: 640 },
    ]);
    expect(toCanvas(definition, plugins).nodes.every((item) => item.style.width === 200)).toBe(
      true,
    );
    expect(canvasNodeWidth(0)).toBe(200);
    expect(canvasNodeWidth(4)).toBe(200);
  });

  it('spreads sibling branches horizontally and gives every bottom output room', () => {
    const available = [...plugins, plugin('many-outputs', [1, 2, 3, 4, 5, 6])];
    const definition = {
      nodes: [node('s', 'start'), node('a', 'branch'), node('b', 'many-outputs'), node('c')],
      edges: [edge('s', 'a'), edge('a', 'b'), edge('a', 'c', 2)],
    };
    const layout = autoLayout(definition, available);
    const projected = toCanvas(definition, available);
    const wide = projected.nodes.find((item) => item.id === 'b')!;
    expect(wide.style.width).toBe(6 * 48);
    expect(layout.b!.y).toBe(layout.c!.y);
    expect(layout.b!.y).toBeGreaterThan(layout.a!.y);
    expect(layout.c!.x - layout.b!.x).toBe(wide.style.width + 48);
  });

  it('reserves bottom connector space for undeclared outputs without altering the flow', () => {
    const definition = chain();
    definition.edges.push(...[2, 3, 4, 5, 6].map((number) => edge('a', 'b', number)));
    const projected = toCanvas(definition, plugins);
    const malformed = projected.nodes.find((item) => item.id === 'a')!;
    expect(malformed.data.outputs).toHaveLength(6);
    expect(malformed.style.width).toBe(288);
    expect(fromCanvas(projected.nodes, projected.edges)).toEqual(definition);
  });

  it('round trips complete nodes, pinned versions, nested inputs and unknown fields', () => {
    const definition = chain();
    const extended = { ...definition.nodes[1]!, future: { retain: true } };
    definition.nodes[1] = extended;
    const projected = toCanvas(definition, plugins, [], { s: { x: 999, y: 42 } });
    expect(projected.nodes[0]!.position).toEqual({ x: 999, y: 42 });
    expect(fromCanvas(projected.nodes, projected.edges)).toEqual(definition);
    expect(fromCanvas(projected.nodes, projected.edges).nodes[1]!.pluginVersion).toBe('1.0');
    expect(JSON.stringify(fromCanvas(projected.nodes, projected.edges))).not.toContain('position');
  });

  it('translates rewired edge endpoints back to the flow contract', () => {
    const projected = toCanvas(chain(), plugins);
    projected.edges[0] = { ...projected.edges[0]!, sourceHandle: '2', target: 'c' };
    expect(fromCanvas(projected.nodes, projected.edges).edges[0]).toEqual(edge('s', 'c', 2));
  });

  it('uses plugin metadata, not incoming-edge guesses, for Start', () => {
    const definition = {
      nodes: [node('orphan'), node('s', 'start'), node('a')],
      edges: [edge('s', 'a'), edge('a', 's')],
    };
    expect(startNodeId(definition, plugins)).toBe('s');
    const projected = toCanvas(definition, plugins);
    expect(projected.nodes.find((item) => item.id === 's')!.deletable).toBe(false);
    expect(projected.nodes.find((item) => item.id === 'orphan')!.data.unreachable).toBe(true);
  });

  it('draws cycles, rejoins and disconnected nodes exactly once with deterministic layout', () => {
    const definition = {
      nodes: [node('s', 'start'), node('a', 'branch'), node('b'), node('c'), node('orphan')],
      edges: [edge('s', 'a'), edge('a', 'b'), edge('a', 'c', 2), edge('b', 'c'), edge('c', 'a')],
    };
    const projected = toCanvas(definition, plugins);
    expect(projected.nodes.map((item) => item.id)).toEqual(['s', 'a', 'b', 'c', 'orphan']);
    expect(projected.edges).toHaveLength(5);
    expect(reachableNodeIds(definition, 's')).toEqual(new Set(['s', 'a', 'b', 'c']));
    expect(projected.nodes.filter((item) => item.data.unreachable).map((item) => item.id)).toEqual([
      'orphan',
    ]);
    const layout = autoLayout(definition, plugins);
    expect(layout).toEqual(autoLayout(definition, plugins));
    expect(new Set(Object.values(layout).map((position) => JSON.stringify(position))).size).toBe(5);
  });

  it('does not invent a Start for unknown plugins or a graph with no Start', () => {
    const definition = { nodes: [node('a'), node('b')], edges: [edge('a', 'b'), edge('b', 'a')] };
    expect(toCanvas(definition, plugins).nodes.every((item) => item.data.unreachable)).toBe(true);
    expect(startNodeId(definition, plugins)).toBeUndefined();
    expect(autoLayout({ nodes: [], edges: [] }, plugins)).toEqual({});
  });

  it('keeps missing/disabled plugins and undeclared existing outputs visible', () => {
    const disabled = { ...plugin('disabled'), enabled: false };
    const definition = {
      nodes: [node('s', 'start'), node('u', 'unknown'), node('d', 'disabled')],
      edges: [edge('s', 'u', 99), edge('u', 'd', 7)],
    };
    const projected = toCanvas(definition, [...plugins, disabled]);
    expect(projected.nodes[0]!.data.outputs).toContainEqual({
      number: 99,
      tooltip: 'Output not declared by the installed plugin',
      missing: true,
    });
    expect(projected.nodes[1]!.data.plugin).toBeUndefined();
    expect(projected.nodes[1]!.data.outputs[0]!.number).toBe(7);
    expect(projected.nodes[2]!.data.plugin?.enabled).toBe(false);
    expect(fromCanvas(projected.nodes, projected.edges)).toEqual(definition);
  });

  it('maps explicit and edge validation problems onto both endpoints and the exact edge', () => {
    const definition = chain();
    const projected = toCanvas(definition, plugins, [
      { code: 'node', message: 'Bad input', nodeId: 'a' },
      { code: 'edge', message: 'Bad wire', edge: edge('a', 'b') },
      { code: 'global', message: 'Global issue' },
    ]);
    expect(projected.nodes.find((item) => item.id === 'a')!.data.problems).toEqual([
      'Bad input',
      'Bad wire',
    ]);
    expect(projected.nodes.find((item) => item.id === 'b')!.data.problems).toEqual(['Bad wire']);
    expect(projected.edges[1]!.data.problems).toEqual(['Bad wire']);
    expect(projected.edges[0]!.data.problems).toEqual([]);
  });

  it('keeps edge identity stable when other edges are deleted, including malformed duplicates', () => {
    const definition = chain();
    definition.edges.push(edge('a', 'b'));
    const before = toCanvas(definition, plugins);
    const after = toCanvas({ ...definition, edges: definition.edges.slice(1) }, plugins);
    expect(before.edges[1]!.id).toBe(after.edges[0]!.id);
    expect(new Set(before.edges.map((item) => item.id)).size).toBe(4);
  });
});

describe('structural graph mutations', () => {
  it('allocates flow-local IDs without WebCrypto and skips existing or earlier session IDs', () => {
    const definition = { nodes: [node('node-1'), node('node-2'), node('node-4')], edges: [] };
    expect(nextNodeId(definition)).toBe('node-3');
    expect(nextNodeId(definition, 4)).toBe('node-5');
    expect(nextNodeId(definition, 10)).toBe('node-10');
    expect(nextNodeId({ nodes: [], edges: [] })).toBe('node-1');
  });

  it('adds metadata defaults and version without replacing existing input values', () => {
    const original = chain();
    const next = addPluginNode(original, plugins[1]!, 'new', plugins);
    expect(next.nodes.at(-1)).toEqual({
      id: 'new',
      pluginId: 'step',
      pluginVersion: '2.0',
      inputs: { enabled: false },
    });
    expect(next.nodes[0]).toBe(original.nodes[0]);
    expect(original.nodes).toHaveLength(4);
  });

  it('rejects duplicate IDs, disabled plugins and second Starts', () => {
    const original = chain();
    expect(addPluginNode(original, plugins[1]!, 'a', plugins)).toBe(original);
    expect(addPluginNode(original, { ...plugins[1]!, enabled: false }, 'new', plugins)).toBe(
      original,
    );
    expect(addPluginNode(original, plugins[0]!, 'new-start', plugins)).toBe(original);
    expect(
      addPluginNode({ nodes: [], edges: [] }, plugins[0]!, 'first', plugins).nodes,
    ).toHaveLength(1);
  });

  it('allows cycles and rejoins but never silently steals an occupied output', () => {
    const original = chain();
    const cycle = connectNodes(original, edge('c', 'a'), plugins);
    expect(cycle.edges.at(-1)).toEqual(edge('c', 'a'));
    expect(connectNodes(original, edge('a', 'c'), plugins)).toBe(original);
    expect(connectNodes(original, edge('c', 's'), plugins).edges.at(-1)).toEqual(edge('c', 's'));
    expect(connectNodes(original, edge('c', 'missing'), plugins)).toBe(original);
    expect(connectNodes(original, edge('c', 'a', 9), plugins)).toBe(original);
    expect(connectNodes(original, edge('c', 'c'), plugins).edges.at(-1)).toEqual(edge('c', 'c'));
  });

  it('reconnects the selected edge at either endpoint without disturbing other branches', () => {
    const original = chain();
    const reconnected = connectNodes(original, edge('a', 'c'), plugins, 1);
    expect(reconnected.edges).toEqual([edge('s', 'a'), edge('a', 'c'), edge('b', 'c')]);
    expect(connectNodes(original, edge('c', 'b'), plugins, 1).edges[1]).toEqual(edge('c', 'b'));
    expect(connectNodes(original, edge('b', 'a'), plugins, 1)).toBe(original);
    expect(connectNodes(original, edge('a', 'b'), plugins, 1)).toBe(original);
  });

  it('allows reconnecting into Start because cycles are valid, while Start remains protected', () => {
    const original = chain();
    const next = connectNodes(original, edge('a', 's'), plugins, 1);
    expect(next.edges[1]).toEqual(edge('a', 's'));
    expect(toCanvas(next, plugins).nodes.find((item) => item.id === 's')!.deletable).toBe(false);
  });

  it('inserts on a chosen branch using an explicit continuation output', () => {
    const original = chain();
    const next = insertNodeOnEdge(original, 1, plugins[2]!, 'inserted', 2, plugins);
    expect(next.edges).toEqual([
      edge('s', 'a'),
      edge('a', 'inserted'),
      edge('inserted', 'b', 2),
      edge('b', 'c'),
    ]);
    expect(next.nodes.at(-1)!.pluginId).toBe('branch');
    expect(insertNodeOnEdge(original, 1, plugins[2]!, 'inserted', 99, plugins)).toBe(original);
    expect(insertNodeOnEdge(original, 1, plugins[0]!, 'inserted', 1, plugins)).toBe(original);
    expect(insertNodeOnEdge(original, 90, plugins[1]!, 'inserted', 1, plugins)).toBe(original);
  });

  it('heals a chain across a simultaneous multi-node deletion, preserving upstream output numbers', () => {
    const original = chain();
    original.edges[0] = edge('s', 'a', 2);
    const next = deleteSelection(original, ['a', 'b'], [], plugins);
    expect(next.nodes.map((item) => item.id)).toEqual(['s', 'c']);
    expect(next.edges).toEqual([edge('s', 'c', 2)]);
    expect(original.nodes).toHaveLength(4);
  });

  it('heals box-selected nodes even when React Flow also selects their incident wires', () => {
    const next = deleteCanvasSelection(chain(), ['a'], [0, 1], plugins);
    expect(next.nodes.map((item) => item.id)).toEqual(['s', 'b', 'c']);
    expect(next.edges).toEqual([edge('s', 'b'), edge('b', 'c')]);
    expect(deleteCanvasSelection(chain(), ['a', 'b'], [0, 1, 2], plugins).edges).toEqual([
      edge('s', 'c'),
    ]);
  });

  it('still deletes independent selected wires and wires beside a protected Start', () => {
    expect(deleteCanvasSelection(chain(), ['a'], [0, 1, 2], plugins).edges).toEqual([
      edge('s', 'b'),
    ]);
    expect(deleteCanvasSelection(chain(), ['s'], [0], plugins).edges).toEqual([
      edge('a', 'b'),
      edge('b', 'c'),
    ]);
    expect(deleteCanvasSelection(chain(), [], [1], plugins).edges).toEqual([
      edge('s', 'a'),
      edge('b', 'c'),
    ]);
  });

  it('heals multiple incoming paths through a deterministic node', () => {
    const definition = chain();
    definition.nodes.push(node('other'));
    definition.edges.push(edge('other', 'a', 2));
    expect(deleteSelection(definition, ['a'], [], plugins).edges).toEqual([
      edge('s', 'b'),
      edge('b', 'c'),
      edge('other', 'b', 2),
    ]);
  });

  it('never chooses one outgoing branch when deleting a branch node, even when targets rejoin', () => {
    const definition = chain();
    definition.edges.push(edge('a', 'c', 2));
    expect(deleteSelection(definition, ['a'], [], plugins).edges).toEqual([edge('b', 'c')]);
    definition.edges[3] = edge('a', 'b', 2);
    expect(deleteSelection(definition, ['a'], [], plugins).edges).toEqual([edge('b', 'c')]);
  });

  it('does not heal through an explicitly removed edge or a removed closed cycle', () => {
    const definition = chain();
    expect(deleteSelection(definition, ['a'], [1], plugins).edges).toEqual([edge('b', 'c')]);
    expect(deleteSelection(definition, ['a'], [0], plugins).edges).toEqual([edge('b', 'c')]);
    definition.edges[2] = edge('b', 'a');
    expect(deleteSelection(definition, ['a', 'b'], [], plugins).edges).toEqual([]);
  });

  it('does not mistake an unwired terminal branch or unknown metadata for a safe successor', () => {
    const definition = chain();
    definition.nodes[1] = node('a', 'branch');
    expect(deleteSelection(definition, ['a'], [], plugins).edges).toEqual([edge('b', 'c')]);
    definition.nodes[1] = node('a', 'unavailable');
    expect(deleteSelection(definition, ['a'], [], plugins).edges).toEqual([edge('b', 'c')]);
    definition.nodes[1] = node('a');
    definition.edges[1] = edge('a', 'b', 99);
    expect(deleteSelection(definition, ['a'], [], plugins).edges).toEqual([edge('b', 'c')]);
  });

  it('protects the one Start in multi-selection while allowing invalid extra Starts to be removed', () => {
    const definition = chain();
    expect(deleteSelection(definition, ['s'], [], plugins)).toBe(definition);
    const deleted = deleteSelection(definition, ['s', 'a', 'b'], [], plugins);
    expect(deleted.nodes.map((item) => item.id)).toEqual(['s', 'c']);
    expect(deleted.edges).toEqual([edge('s', 'c')]);
    definition.nodes.push(node('extra', 'start'));
    expect(deleteSelection(definition, ['extra'], [], plugins).nodes).toHaveLength(4);
  });

  it('preserves unrelated malformed duplicate edges on no-op and node deletion', () => {
    const definition = chain();
    definition.edges.push(edge('s', 'a'));
    expect(deleteSelection(definition, [], [], plugins)).toBe(definition);
    expect(deleteSelection(definition, ['c'], [], plugins).edges).toEqual([
      edge('s', 'a'),
      edge('a', 'b'),
      edge('s', 'a'),
    ]);
  });

  it('deletes selected edges without implicitly deleting nodes', () => {
    const original = chain();
    const next = deleteSelection(original, [], [1], plugins);
    expect(next.nodes).toEqual(original.nodes);
    expect(next.edges).toEqual([edge('s', 'a'), edge('b', 'c')]);
  });
});

describe('session-local undo and redo', () => {
  const initial = (): CanvasHistory => ({
    past: [],
    present: { definition: chain(), layout: { s: { x: 0, y: 0 } } },
    future: [],
  });

  it('records keyboard movement in layout and undo history without changing the definition', () => {
    const history = initial();
    const layout = settledLayout(history.present.layout, [
      { type: 'position', id: 's', position: { x: 20, y: 0 }, dragging: false },
    ]);
    const moved = pushHistory(history, { ...history.present, layout });
    expect(moved.present.layout.s).toEqual({ x: 20, y: 0 });
    expect(toCanvas(chain(), plugins, [], moved.present.layout).nodes[0]!.position).toEqual({
      x: 20,
      y: 0,
    });
    expect(undoHistory(moved)).toMatchObject({ present: history.present });
    expect(moved.present.definition).toBe(history.present.definition);
  });

  it('records a multi-node mouse drag once, on its final position changes', () => {
    const history = initial();
    expect(
      settledLayout(history.present.layout, [
        { type: 'position', id: 's', position: { x: 10, y: 10 }, dragging: true },
        { type: 'dimensions', id: 's' },
      ]),
    ).toBe(history.present.layout);
    const layout = settledLayout(history.present.layout, [
      { type: 'position', id: 's', position: { x: 20, y: 20 }, dragging: false },
      { type: 'position', id: 'a', position: { x: 80, y: 20 }, dragging: false },
    ]);
    const moved = pushHistory(history, { ...history.present, layout });
    expect(moved.past).toHaveLength(1);
    expect(moved.present.layout).toEqual({ s: { x: 20, y: 20 }, a: { x: 80, y: 20 } });
    expect(
      settledLayout(layout, [
        { type: 'position', id: 's', position: { x: 20, y: 20 } },
        { type: 'position', id: 'a' },
      ]),
    ).toBe(layout);
  });

  it('tracks layout-only changes without changing the definition', () => {
    const history = initial();
    const moved = pushHistory(history, {
      ...history.present,
      layout: { s: { x: 100, y: 100 } },
    });
    expect(moved.present.definition).toBe(history.present.definition);
    expect(definitionsEqual(moved.present.definition, history.present.definition)).toBe(true);
    expect(undoHistory(moved).present).toEqual(history.present);
    expect(redoHistory(undoHistory(moved))).toEqual(moved);
  });

  it('undoes node insertion, restores positions, and clears redo after a different edit', () => {
    const history = initial();
    const added = pushHistory(history, {
      definition: addPluginNode(history.present.definition, plugins[1]!, 'new', plugins),
      layout: { ...history.present.layout, new: { x: 500, y: 100 } },
    });
    const undone = undoHistory(added);
    expect(undone.present).toEqual(history.present);
    expect(redoHistory(undone).present).toEqual(added.present);
    const replaced = pushHistory(undone, {
      ...undone.present,
      definition: deleteSelection(undone.present.definition, ['a'], [], plugins),
    });
    expect(replaced.future).toEqual([]);
  });

  it('does not store no-ops and bounds history memory', () => {
    let history = initial();
    expect(pushHistory(history, history.present)).toBe(history);
    expect(undoHistory(history)).toBe(history);
    expect(redoHistory(history)).toBe(history);
    for (let index = 1; index <= 120; index += 1) {
      history = pushHistory(history, {
        ...history.present,
        layout: { s: { x: index, y: 0 } },
      });
    }
    expect(history.past).toHaveLength(100);
  });
});
