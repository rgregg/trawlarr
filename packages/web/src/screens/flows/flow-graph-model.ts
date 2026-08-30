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
  /**
   * Every OTHER edge that reaches this node, as `output N of <nodeId>`.
   *
   * THIS IS THE MARKER THE MUXQUEUE DEFECT NEEDED. A node reached from two
   * branches is drawn once — correctly; real flows rejoin, and drawing it
   * twice would report a graph with more nodes than the flow has — but
   * drawing it once under the first branch that reached it silently hid the
   * second. The `-max_muxing_queue_size` node sat on BOTH branches of a
   * codec check, and a screen that drew it under output 1 alone would render
   * the canonical instance of the bug as though it were correctly placed.
   * Empty for the overwhelmingly common single-parent node.
   */
  alsoReachedFrom: string[];
  /**
   * True for a node NO path from the root reaches: an orphan left behind by
   * a deleted edge, or a node inside a cycle that hangs off nothing. These
   * are drawn, at depth 0, after the walk. A screen that exists to make a
   * misplaced node visible must not be the one thing that hides it — a node
   * silently absent from the drawing reads as a node that is not in the
   * flow, which is the opposite of the truth.
   */
  unreachable: boolean;
}

/**
 * A depth-first walk from the one node nothing points at (the start node).
 *
 * VISITED ONCE, however many edges lead to it: the real conform flow used in
 * production rejoins both branches of its codec check at the audio node, so
 * a node reached twice is the normal shape of a flow, not an edge case — a
 * walk that rendered it twice would draw a graph with more nodes than the
 * flow actually has. The edges that did NOT draw it are named on the row
 * instead, as `alsoReachedFrom`.
 *
 * `branchLabel` names which OUTPUT of the parent sent execution to this
 * node, not the parent itself: `checkVideoCodec`'s output 1 and output 2 are
 * different decisions ("already the right codec" vs. "needs encoding"), and
 * that distinction — not the node id — is what made the muxqueue node's
 * placement wrong at a glance once drawn.
 *
 * WHAT AN UNDRAWABLE DEFINITION DOES. Only a definition with NO NODES AT ALL
 * returns `[]`. A definition with nodes but no start node — every node has an
 * inbound edge, i.e. the graph is one big cycle — is drawn from
 * `nodes[0]` and its unreachable remainder is appended, because a malformed
 * flow is exactly the case this screen exists to make visible and refusing to
 * draw it would leave the operator with the JSON they already could not read.
 * (The doc comment here used to promise `[]` for both, which the code has
 * never done for the second; the code is the intended behaviour and this
 * paragraph now says so.)
 */
export const toGraphRows = (definition: FlowDefinition): GraphRow[] => {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const targets = new Set(definition.edges.map((edge) => edge.toNodeId));
  const root =
    definition.nodes.find((node) => !targets.has(node.id))?.id ?? definition.nodes[0]?.id;
  if (root === undefined) return [];

  const rows: GraphRow[] = [];
  const seen = new Set<string>();
  // Which edge actually drew each node, so the OTHERS can be named on it.
  const drawnBy = new Map<string, { fromNodeId: string; outputNumber: number }>();

  const toRow = (
    node: { id: string; pluginId: string; inputs?: Record<string, unknown> },
    depth: number,
    branchLabel: string | null,
    unreachable: boolean,
  ): GraphRow => ({
    depth,
    nodeId: node.id,
    pluginId: node.pluginId,
    branchLabel,
    inputs: Object.entries(node.inputs ?? {}).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })),
    alsoReachedFrom: [],
    unreachable,
  });

  const walk = (
    nodeId: string,
    depth: number,
    branchLabel: string | null,
    via: { fromNodeId: string; outputNumber: number } | null,
  ): void => {
    if (seen.has(nodeId)) return;
    const node = byId.get(nodeId);
    if (node === undefined) return;
    seen.add(nodeId);
    if (via !== null) drawnBy.set(nodeId, via);
    rows.push(toRow(node, depth, branchLabel, false));
    const outgoing = definition.edges
      .filter((edge) => edge.fromNodeId === nodeId)
      .sort((left, right) => left.outputNumber - right.outputNumber);
    for (const edge of outgoing) {
      walk(edge.toNodeId, depth + 1, `output ${String(edge.outputNumber)}`, {
        fromNodeId: nodeId,
        outputNumber: edge.outputNumber,
      });
    }
  };

  walk(root, 0, null, null);

  // Nodes no path from the root reaches, drawn rather than dropped.
  for (const node of definition.nodes) {
    if (seen.has(node.id)) continue;
    rows.push(toRow(node, 0, null, true));
  }

  // Every inbound edge that did not draw its target, named on the target.
  for (const row of rows) {
    const drawn = drawnBy.get(row.nodeId);
    row.alsoReachedFrom = definition.edges
      .filter(
        (edge) =>
          edge.toNodeId === row.nodeId &&
          !(
            drawn !== undefined &&
            edge.fromNodeId === drawn.fromNodeId &&
            edge.outputNumber === drawn.outputNumber
          ),
      )
      .map((edge) => `output ${String(edge.outputNumber)} of ${edge.fromNodeId}`);
  }

  return rows;
};
