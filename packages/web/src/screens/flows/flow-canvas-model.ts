import type { FlowDefinition, FlowEdge, FlowLayout, FlowNode } from '@trawlarr/core';
import type { PluginDetails } from '@trawlarr/plugin-api';
import { inputDefaults } from './plugin-input-model.js';

export type EditorPlugin = {
  id: string;
  name: string;
  description: string;
  tags: string;
  version: string;
  enabled: boolean;
  isStartPlugin: boolean;
  source: string;
  details: PluginDetails;
};

export type ValidationProblem = {
  code: string;
  message: string;
  nodeId?: string;
  edge?: FlowEdge;
};

export type CanvasPosition = { x: number; y: number };
export type CanvasLayout = FlowLayout;
export type CanvasNodeData = {
  [key: string]: unknown;
  node: FlowNode;
  plugin?: EditorPlugin;
  protectedStart: boolean;
  errorEntry: boolean;
  unreachable: boolean;
  outputs: Array<{ number: number; tooltip: string; missing: boolean }>;
  problems: string[];
};
export type CanvasNode = {
  id: string;
  type: 'plugin';
  position: CanvasPosition;
  style: { width: number };
  deletable: boolean;
  data: CanvasNodeData;
};
export type CanvasEdge = {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  label: string;
  data: { edge: FlowEdge; problems: string[] };
};

export function sameEdge(left: FlowEdge, right: FlowEdge): boolean {
  return (
    left.fromNodeId === right.fromNodeId &&
    left.toNodeId === right.toNodeId &&
    left.outputNumber === right.outputNumber
  );
}

export function startNodeId(
  definition: FlowDefinition,
  plugins: EditorPlugin[],
): string | undefined {
  return definition.nodes.find((node) =>
    plugins.some(
      (plugin) =>
        plugin.id === node.pluginId && (plugin.isStartPlugin || plugin.details.isStartPlugin),
    ),
  )?.id;
}

export function reachableNodeIds(definition: FlowDefinition, start?: string): Set<string> {
  const reached = new Set<string>();
  const pending = start === undefined ? [] : [start];
  const outgoing = new Map<string, string[]>();
  for (const edge of definition.edges) {
    outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge.toNodeId]);
  }
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index]!;
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...(outgoing.get(id) ?? []));
  }
  return reached;
}

const errorEntryIds = (definition: FlowDefinition, plugins: EditorPlugin[]): string[] =>
  definition.nodes
    .filter((node) =>
      plugins.some(
        (plugin) => plugin.id === node.pluginId && plugin.details.pType === 'onFlowError',
      ),
    )
    .map((node) => node.id);

export const canvasNodeWidth = (outputCount: number): number => Math.max(200, outputCount * 48);

/** Top-to-bottom layers terminate on cycles and keep rejoined nodes in one place. */
export function autoLayout(definition: FlowDefinition, plugins: EditorPlugin[]): CanvasLayout {
  const depth = new Map<string, number>();
  const start = startNodeId(definition, plugins);
  const pending = [...(start === undefined ? [] : [start]), ...errorEntryIds(definition, plugins)];
  for (const id of pending) depth.set(id, 0);
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index]!;
    for (const edge of definition.edges.filter((candidate) => candidate.fromNodeId === id)) {
      if (depth.has(edge.toNodeId)) continue;
      depth.set(edge.toNodeId, depth.get(id)! + 1);
      pending.push(edge.toNodeId);
    }
  }
  const columns = new Map<number, number>();
  const orphanLayer = Math.max(0, ...depth.values()) + 1;
  return Object.fromEntries(
    definition.nodes.map((node) => {
      const layer = depth.get(node.id) ?? orphanLayer;
      const x = columns.get(layer) ?? 40;
      const plugin = plugins.find((candidate) => candidate.id === node.pluginId);
      const outputs = new Set([
        ...(plugin?.details.outputs.map((output) => output.number) ?? []),
        ...definition.edges
          .filter((edge) => edge.fromNodeId === node.id)
          .map((edge) => edge.outputNumber),
      ]);
      columns.set(layer, x + canvasNodeWidth(outputs.size) + 48);
      return [node.id, { x, y: 40 + layer * 200 }];
    }),
  );
}

export function toCanvas(
  definition: FlowDefinition,
  plugins: EditorPlugin[],
  problems: ValidationProblem[] = [],
  layout: CanvasLayout = {},
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const start = startNodeId(definition, plugins);
  const reachable = reachableNodeIds(definition, start);
  const errorEntries = errorEntryIds(definition, plugins);
  for (const entry of errorEntries) {
    for (const id of reachableNodeIds(definition, entry)) reachable.add(id);
  }
  const fallback = autoLayout(definition, plugins);
  return {
    nodes: definition.nodes.map((node) => {
      const plugin = plugins.find((candidate) => candidate.id === node.pluginId);
      const outputs = (plugin?.details.outputs ?? []).map((output) => ({
        number: output.number,
        tooltip: output.tooltip,
        missing: false,
      }));
      for (const edge of definition.edges.filter((edge) => edge.fromNodeId === node.id)) {
        if (!outputs.some((output) => output.number === edge.outputNumber)) {
          outputs.push({
            number: edge.outputNumber,
            tooltip: 'Output not declared by the installed plugin',
            missing: true,
          });
        }
      }
      return {
        id: node.id,
        type: 'plugin',
        position: layout[node.id] ?? fallback[node.id]!,
        style: { width: canvasNodeWidth(outputs.length) },
        deletable: node.id !== start,
        data: {
          node,
          plugin,
          protectedStart: node.id === start,
          errorEntry: errorEntries.includes(node.id),
          unreachable: !reachable.has(node.id),
          outputs,
          problems: problems
            .filter(
              (problem) =>
                problem.nodeId === node.id ||
                problem.edge?.fromNodeId === node.id ||
                problem.edge?.toNodeId === node.id,
            )
            .map((problem) => problem.message),
        },
      };
    }),
    edges: definition.edges.map((edge, index) => ({
      id: `edge-${JSON.stringify([edge.fromNodeId, edge.outputNumber, edge.toNodeId])}-${definition.edges.slice(0, index).filter((candidate) => sameEdge(candidate, edge)).length}`,
      source: edge.fromNodeId,
      sourceHandle: String(edge.outputNumber),
      target: edge.toNodeId,
      targetHandle: 'input',
      label: `Output ${edge.outputNumber}`,
      data: {
        edge,
        problems: problems
          .filter((problem) => problem.edge && sameEdge(problem.edge, edge))
          .map((problem) => problem.message),
      },
    })),
  };
}

/** Layout and React Flow selection never enter the executable definition or its hash. */
export function fromCanvas(nodes: CanvasNode[], edges: CanvasEdge[]): FlowDefinition {
  return {
    nodes: nodes.map((node) => node.data.node),
    edges: edges.map((edge) => ({
      ...edge.data.edge,
      fromNodeId: edge.source,
      outputNumber: Number(edge.sourceHandle),
      toNodeId: edge.target,
    })),
  };
}

export function addPluginNode(
  definition: FlowDefinition,
  plugin: EditorPlugin,
  id: string,
  plugins: EditorPlugin[],
): FlowDefinition {
  if (
    !plugin.enabled ||
    definition.nodes.some((node) => node.id === id) ||
    ((plugin.isStartPlugin || plugin.details.isStartPlugin) &&
      startNodeId(definition, plugins) !== undefined) ||
    (plugin.details.pType === 'onFlowError' && errorEntryIds(definition, plugins).length > 0)
  ) {
    return definition;
  }
  return {
    ...definition,
    nodes: [
      ...definition.nodes,
      {
        id,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        inputs: inputDefaults(plugin.details.inputs),
      },
    ],
  };
}

export function nextNodeId(definition: FlowDefinition, sequence = 1): string {
  const ids = new Set(definition.nodes.map((node) => node.id));
  let candidate = sequence;
  while (ids.has(`node-${candidate}`)) candidate += 1;
  return `node-${candidate}`;
}

export function connectNodes(
  definition: FlowDefinition,
  edge: FlowEdge,
  plugins: EditorPlugin[],
  replacingIndex?: number,
): FlowDefinition {
  const source = definition.nodes.find((node) => node.id === edge.fromNodeId);
  const target = definition.nodes.find((node) => node.id === edge.toNodeId);
  const plugin = plugins.find((candidate) => candidate.id === source?.pluginId);
  if (
    !source ||
    !target ||
    !Number.isInteger(edge.outputNumber) ||
    (plugin && !plugin.details.outputs.some((output) => output.number === edge.outputNumber))
  ) {
    return definition;
  }
  const edges = definition.edges.filter((_, index) => index !== replacingIndex);
  // Never silently steal a wired output. Delete its edge or explicitly reconnect it.
  if (
    edges.some(
      (existing) =>
        existing.fromNodeId === edge.fromNodeId && existing.outputNumber === edge.outputNumber,
    )
  ) {
    return definition;
  }
  if (
    replacingIndex !== undefined &&
    definition.edges[replacingIndex] &&
    sameEdge(definition.edges[replacingIndex], edge)
  ) {
    return definition;
  }
  if (replacingIndex === undefined) edges.push(edge);
  else edges.splice(replacingIndex, 0, { ...definition.edges[replacingIndex], ...edge });
  return { ...definition, edges };
}

export function insertNodeOnEdge(
  definition: FlowDefinition,
  edgeIndex: number,
  plugin: EditorPlugin,
  id: string,
  outputNumber: number,
  plugins: EditorPlugin[],
): FlowDefinition {
  const edge = definition.edges[edgeIndex];
  if (
    !edge ||
    plugin.isStartPlugin ||
    plugin.details.isStartPlugin ||
    !plugin.details.outputs.some((output) => output.number === outputNumber)
  ) {
    return definition;
  }
  const next = addPluginNode(definition, plugin, id, plugins);
  if (next === definition) return definition;
  return {
    ...next,
    edges: next.edges.flatMap((current, index) =>
      index === edgeIndex
        ? [
            { ...current, toNodeId: id },
            { fromNodeId: id, outputNumber, toNodeId: current.toNodeId },
          ]
        : [current],
    ),
  };
}

/**
 * Heal only deterministic paths through the entire deletion set. A branch,
 * removed edge or closed cycle has no single honest successor.
 */
export function deleteSelection(
  definition: FlowDefinition,
  nodeIds: string[],
  edgeIndices: number[],
  plugins: EditorPlugin[],
): FlowDefinition {
  const start = startNodeId(definition, plugins);
  const removed = new Set(nodeIds.filter((id) => id !== start));
  const removedEdges = new Set(edgeIndices);
  const edges: FlowEdge[] = [];
  const walk = (id: string, visited: Set<string>): string | undefined => {
    if (!removed.has(id)) return id;
    if (visited.has(id)) return undefined;
    visited.add(id);
    const node = definition.nodes.find((candidate) => candidate.id === id);
    const plugin = plugins.find((candidate) => candidate.id === node?.pluginId);
    // An unwired output is a terminal branch, not permission to choose the
    // sole wired output. Unknown metadata cannot establish a safe successor.
    if (!plugin || plugin.details.outputs.length !== 1) return undefined;
    const outgoing = definition.edges
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => edge.fromNodeId === id);
    if (outgoing.length !== 1 || removedEdges.has(outgoing[0]!.index)) return undefined;
    if (outgoing[0]!.edge.outputNumber !== plugin.details.outputs[0]!.number) return undefined;
    return walk(outgoing[0]!.edge.toNodeId, visited);
  };
  definition.edges.forEach((edge, index) => {
    if (removed.has(edge.fromNodeId) || removedEdges.has(index)) return;
    const target = walk(edge.toNodeId, new Set());
    if (target === undefined) return;
    edges.push({ ...edge, toNodeId: target });
  });
  const next = {
    ...definition,
    nodes: definition.nodes.filter((node) => !removed.has(node.id)),
    edges,
  };
  return definitionsEqual(definition, next) ? definition : next;
}

/** React Flow box-selection includes incident wires as part of selecting a node. */
export function deleteCanvasSelection(
  definition: FlowDefinition,
  nodeIds: string[],
  edgeIndices: number[],
  plugins: EditorPlugin[],
): FlowDefinition {
  const start = startNodeId(definition, plugins);
  const removed = new Set(nodeIds.filter((id) => id !== start));
  // Node deletion owns its incident wires and may heal the path. Only wires
  // selected independently of deleted nodes are additional disconnections.
  const independentEdges = edgeIndices.filter((index) => {
    const edge = definition.edges[index];
    return edge !== undefined && !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId);
  });
  return deleteSelection(definition, nodeIds, independentEdges, plugins);
}

export function settledLayout(
  layout: CanvasLayout,
  changes: Array<{
    type: string;
    id?: string;
    position?: CanvasPosition;
    dragging?: boolean;
  }>,
): CanvasLayout {
  let next = layout;
  for (const change of changes) {
    if (change.type !== 'position' || change.dragging || !change.position || !change.id) continue;
    const previous = next[change.id];
    if (previous?.x === change.position.x && previous.y === change.position.y) continue;
    if (next === layout) next = { ...layout };
    next[change.id] = { ...change.position };
  }
  return next;
}

export function definitionsEqual(left: FlowDefinition, right: FlowDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type CanvasSnapshot = { definition: FlowDefinition; layout: CanvasLayout };
export type CanvasHistory = {
  past: CanvasSnapshot[];
  present: CanvasSnapshot;
  future: CanvasSnapshot[];
};

export function pushHistory(history: CanvasHistory, next: CanvasSnapshot): CanvasHistory {
  if (
    definitionsEqual(history.present.definition, next.definition) &&
    JSON.stringify(history.present.layout) === JSON.stringify(next.layout)
  ) {
    return history;
  }
  return {
    past: [...history.past.slice(-99), history.present],
    present: next,
    future: [],
  };
}

export function undoHistory(history: CanvasHistory): CanvasHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoHistory(history: CanvasHistory): CanvasHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}
