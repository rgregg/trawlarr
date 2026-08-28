/**
 * A flow, drawn.
 *
 * "Why did this file get rewritten" is nearly always a question about the
 * graph. The `-max_muxing_queue_size` defect — one node on the wrong branch
 * of a codec check, which queued about 9.2 TB of pointless rewrites — is
 * obvious when the branches are drawn and was invisible in the JSON for days.
 *
 * This mirrors the wire shape `GET /flows/:id` actually returns
 * (`packages/server/src/api/routes/flows.ts`'s `toFlowResource`, over
 * `@trawlarr/core`'s `FlowDefinition`) rather than importing it: the server
 * package is not a dependency of `packages/web`, and the fields this screen
 * reads — `id`, `pluginId`, `inputs` on a node; `fromNodeId`, `outputNumber`,
 * `toNodeId` on an edge — are the only ones that matter here.
 */
export interface FlowDefinition {
  nodes: Array<{ id: string; pluginId: string; inputs?: Record<string, unknown> }>;
  edges: Array<{ fromNodeId: string; outputNumber: number; toNodeId: string }>;
}

export interface GraphRow {
  depth: number;
  nodeId: string;
  pluginId: string;
  branchLabel: string | null;
  inputs: Array<{ key: string; value: string }>;
}

/**
 * A depth-first walk from the one node nothing points at (the start node).
 *
 * VISITED ONCE, however many edges lead to it: the real conform flow used in
 * production rejoins both branches of its codec check at the audio node, so
 * a node reached twice is the normal shape of a flow, not an edge case — a
 * walk that rendered it twice would draw a graph with more nodes than the
 * flow actually has.
 *
 * `branchLabel` names which OUTPUT of the parent sent execution to this
 * node, not the parent itself: `checkVideoCodec`'s output 1 and output 2 are
 * different decisions ("already the right codec" vs. "needs encoding"), and
 * that distinction — not the node id — is what made the muxqueue node's
 * placement wrong at a glance once drawn.
 *
 * A DEFINITION WITH NO START NODE (including an empty one) returns `[]`
 * rather than throwing: this feeds a screen that must stay readable even
 * when it is handed something malformed.
 */
export const toGraphRows = (definition: FlowDefinition): GraphRow[] => {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const targets = new Set(definition.edges.map((edge) => edge.toNodeId));
  const root =
    definition.nodes.find((node) => !targets.has(node.id))?.id ?? definition.nodes[0]?.id;
  if (root === undefined) return [];

  const rows: GraphRow[] = [];
  const seen = new Set<string>();

  const walk = (nodeId: string, depth: number, branchLabel: string | null): void => {
    if (seen.has(nodeId)) return;
    const node = byId.get(nodeId);
    if (node === undefined) return;
    seen.add(nodeId);
    rows.push({
      depth,
      nodeId,
      pluginId: node.pluginId,
      branchLabel,
      inputs: Object.entries(node.inputs ?? {}).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      })),
    });
    const outgoing = definition.edges
      .filter((edge) => edge.fromNodeId === nodeId)
      .sort((left, right) => left.outputNumber - right.outputNumber);
    for (const edge of outgoing) {
      walk(edge.toNodeId, depth + 1, `output ${String(edge.outputNumber)}`);
    }
  };

  walk(root, 0, null);
  return rows;
};
