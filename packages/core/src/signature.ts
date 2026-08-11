import { canonicalJson, sha256Hex } from './canonical-json.js';
import { factsHash, type FactSet } from './facts.js';
import type { FlowDefinition, FlowEdge, FlowNode } from './flow.js';

const nodeKey = (node: FlowNode): string => node.id;
const edgeKey = (edge: FlowEdge): string =>
  `${edge.fromNodeId}|${edge.outputNumber}|${edge.toNodeId}`;

/**
 * A total ordering on the sort keys. Returning 0 for equal keys matters: a
 * comparator that answers -1 or 1 for a pair it considers equal is
 * inconsistent, and an inconsistent comparator makes the sort's output
 * implementation-defined — which for a hash of the sorted result means the
 * same flow could hash differently.
 */
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Hash of the entire flow definition: structure, every node's configuration,
 * and every referenced plugin version.
 *
 * Deliberately not the set of plugins a run executed. Which plugins execute
 * depends on running the flow, so a signature defined that way could not be
 * computed before the run it is supposed to make unnecessary. Hashing the
 * whole definition is computable up front; the cost is that editing an
 * unreachable branch invalidates files that would never have reached it,
 * which only ever causes a cheap re-evaluation.
 *
 * This value also serves as the flow's version — there is no separate counter.
 */
export const flowDefinitionHash = (flow: FlowDefinition): string => {
  const nodes = [...flow.nodes].sort((a, b) => byKey(nodeKey(a), nodeKey(b)));
  const edges = [...flow.edges].sort((a, b) => byKey(edgeKey(a), edgeKey(b)));

  return sha256Hex(
    canonicalJson({
      nodes: nodes.map((node) => ({
        id: node.id,
        pluginId: node.pluginId,
        pluginVersion: node.pluginVersion,
        inputs: node.inputs,
      })),
      edges: edges.map((edge) => ({
        fromNodeId: edge.fromNodeId,
        outputNumber: edge.outputNumber,
        toNodeId: edge.toNodeId,
      })),
    }),
  );
};

/** A file is known-good when this matches the value stored at its last success. */
export const computeSignature = (input: { flowDefinitionHash: string; facts: FactSet }): string =>
  sha256Hex(canonicalJson([input.flowDefinitionHash, factsHash(input.facts)]));
