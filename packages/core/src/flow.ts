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
