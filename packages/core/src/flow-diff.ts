import type { FlowDefinition, FlowEdge, FlowNode } from './flow.js';

/**
 * Diffs two flow definitions as a graph, not as text.
 *
 * This exists because a flow defect once queued every file in a real
 * library — 4,621 files, about 9.2 TB — for a pointless rewrite. The
 * defect was exactly one edge: a `muxqueue` node hung off a `check`
 * node's output 1, the branch for files that are ALREADY correct,
 * instead of the encode branch. Rendered as text (or JSON), that
 * one-edge defect is buried in a wall of reformatted, reordered nodes.
 * Rendered as a graph diff, it is one removed edge and one added edge.
 * That rendering is the entire value of this feature.
 */

export type EdgeRef = FlowEdge;

export interface FlowDiff {
  nodesAdded: string[];
  nodesRemoved: string[];
  nodePluginChanged: Array<{ nodeId: string; from: string; to: string }>;
  inputsChanged: Array<{ nodeId: string; key: string; from: string | null; to: string | null }>;
  edgesAdded: EdgeRef[];
  edgesRemoved: EdgeRef[];
}

function edgeKey(edge: EdgeRef): string {
  return `${edge.fromNodeId} ${edge.outputNumber} ${edge.toNodeId}`;
}

function nodesById(nodes: FlowNode[]): Map<string, FlowNode> {
  const map = new Map<string, FlowNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return map;
}

function edgesByKey(edges: EdgeRef[]): Map<string, EdgeRef> {
  const map = new Map<string, EdgeRef>();
  for (const edge of edges) {
    map.set(edgeKey(edge), edge);
  }
  return map;
}

/**
 * An input value in two forms: one to compare on and one to show.
 *
 * They have to be separate. Comparing on the readable form collapses the
 * number `5` and the string `"5"` (and `true` and `"true"`) into one value,
 * so a publish that changed an input's type — what a hand-edited or imported
 * flow produces — gets a different `flowDefinitionHash`, re-queues the
 * library, and shows an empty diff. Showing the compared form instead would
 * quote every string in the UI. So: compare on JSON, display readably, and
 * fall back to the JSON form only when the two readable forms would collide
 * (`5 → 5` tells the reader nothing; `5 → "5"` tells them everything).
 *
 * A missing key is `null` in both forms, which is why `null` is not itself
 * representable here — `JSON.stringify(null)` is the string `'null'`.
 */
interface InputRepr {
  compare: string | null;
  display: string | null;
}

function inputValueRepr(value: unknown): InputRepr {
  if (value === undefined) {
    return { compare: null, display: null };
  }
  const json = JSON.stringify(value) ?? 'undefined';
  return { compare: json, display: typeof value === 'string' ? value : json };
}

function compareEdgeRefs(a: EdgeRef, b: EdgeRef): number {
  return edgeKey(a) < edgeKey(b) ? -1 : edgeKey(a) > edgeKey(b) ? 1 : 0;
}

export function diffFlowDefinitions(from: FlowDefinition, to: FlowDefinition): FlowDiff {
  const fromNodes = nodesById(from.nodes);
  const toNodes = nodesById(to.nodes);
  const fromEdges = edgesByKey(from.edges);
  const toEdges = edgesByKey(to.edges);

  const nodesAdded: string[] = [];
  const nodesRemoved: string[] = [];
  const nodePluginChanged: Array<{ nodeId: string; from: string; to: string }> = [];
  const inputsChanged: Array<{
    nodeId: string;
    key: string;
    from: string | null;
    to: string | null;
  }> = [];

  for (const toNode of to.nodes) {
    const fromNode = fromNodes.get(toNode.id);
    if (fromNode === undefined) {
      nodesAdded.push(toNode.id);
    }
  }

  for (const fromNode of from.nodes) {
    const toNode = toNodes.get(fromNode.id);
    if (toNode === undefined) {
      nodesRemoved.push(fromNode.id);
    }
  }

  for (const toNode of to.nodes) {
    const fromNode = fromNodes.get(toNode.id);
    if (fromNode === undefined) {
      continue;
    }

    // `flowDefinitionHash` hashes `pluginVersion` alongside `pluginId`, so a
    // node whose plugin moved from 1.0.0 to 2.0.0 is a different flow and
    // re-queues the whole library. Diffing on `pluginId` alone reported that
    // as "identical" on the one screen whose entire job is saying what
    // changed. The version is only spelled out when it is what moved, so an
    // ordinary plugin swap still reads as one id becoming another.
    if (fromNode.pluginId !== toNode.pluginId || fromNode.pluginVersion !== toNode.pluginVersion) {
      const versionMoved = fromNode.pluginVersion !== toNode.pluginVersion;
      nodePluginChanged.push({
        nodeId: toNode.id,
        from: versionMoved ? `${fromNode.pluginId}@${fromNode.pluginVersion}` : fromNode.pluginId,
        to: versionMoved ? `${toNode.pluginId}@${toNode.pluginVersion}` : toNode.pluginId,
      });
    }

    const keys = new Set<string>([...Object.keys(fromNode.inputs), ...Object.keys(toNode.inputs)]);
    for (const key of keys) {
      const fromValue = inputValueRepr(fromNode.inputs[key]);
      const toValue = inputValueRepr(toNode.inputs[key]);
      if (fromValue.compare !== toValue.compare) {
        const collides = fromValue.display === toValue.display;
        inputsChanged.push({
          nodeId: toNode.id,
          key,
          from: collides ? fromValue.compare : fromValue.display,
          to: collides ? toValue.compare : toValue.display,
        });
      }
    }
  }

  const edgesAdded: EdgeRef[] = [];
  const edgesRemoved: EdgeRef[] = [];

  for (const toEdge of to.edges) {
    if (!fromEdges.has(edgeKey(toEdge))) {
      edgesAdded.push(toEdge);
    }
  }

  for (const fromEdge of from.edges) {
    if (!toEdges.has(edgeKey(fromEdge))) {
      edgesRemoved.push(fromEdge);
    }
  }

  nodesAdded.sort();
  nodesRemoved.sort();
  nodePluginChanged.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  inputsChanged.sort((a, b) => {
    if (a.nodeId !== b.nodeId) {
      return a.nodeId < b.nodeId ? -1 : 1;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  edgesAdded.sort(compareEdgeRefs);
  edgesRemoved.sort(compareEdgeRefs);

  return { nodesAdded, nodesRemoved, nodePluginChanged, inputsChanged, edgesAdded, edgesRemoved };
}

export function isEmptyDiff(diff: FlowDiff): boolean {
  return (
    diff.nodesAdded.length === 0 &&
    diff.nodesRemoved.length === 0 &&
    diff.nodePluginChanged.length === 0 &&
    diff.inputsChanged.length === 0 &&
    diff.edgesAdded.length === 0 &&
    diff.edgesRemoved.length === 0
  );
}
