export interface FlowNode {
  id: string;
  pluginId: string;
  pluginVersion: string;
  inputs: Record<string, unknown>;
}

export interface FlowEdge {
  fromNodeId: string;
  outputNumber: number;
  toNodeId: string;
}

export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/**
 * Per-node presentation, deliberately outside the definition and its
 * signature: where a node sits, and what it is called on the canvas.
 *
 * A name belongs here for the same reason the flow's own name does (see
 * `FlowRepo.rename`): it changes nothing a file converges against. Putting
 * it in `FlowDefinition` would fold it into `flowDefinitionHash`, and since
 * that hash IS the flow's version, relabelling a node — or typing a comment
 * onto the diagram — would invalidate every file's recorded signature and
 * re-queue the whole library.
 */
export type FlowLayout = Record<string, FlowNodeView>;

export interface FlowNodeView {
  x: number;
  y: number;
  /**
   * What to call this node on the canvas, overriding the plugin's own name.
   * Absent means "use the plugin name", which is what almost every node does.
   */
  name?: string;
}

/**
 * Longest node name that will be stored.
 *
 * Generous because a name is also how a comment node carries its text — the
 * Tdarr contract has no separate field for it, only `details().nameUI`
 * asking for a textarea — but bounded, because this rides in one JSON column
 * beside every node's coordinates.
 */
export const FLOW_NODE_NAME_MAX = 2000;
