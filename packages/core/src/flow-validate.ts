import type { FlowDefinition, FlowEdge, FlowNode } from './flow.js';

/**
 * What a node's plugin declares about itself, reduced to the two facts a flow
 * can be wrong about: which output numbers exist, and whether this is a start
 * plugin. Both come from `details()`; keeping the shape this narrow is what
 * lets validation live in core, which must not load plugin code.
 */
export interface FlowNodeCapabilities {
  outputNumbers: number[];
  isStartPlugin: boolean;
}

/**
 * Resolves a node's plugin to its capabilities, or `null` when this host
 * cannot resolve that plugin at all.
 *
 * `null` is deliberately NOT an error. A flow is a document: it is routinely
 * written on one machine and run on another (the plugin directory is mounted
 * into a container; a flow is exported and imported), so a community plugin
 * being absent where the flow is being edited says nothing about whether the
 * flow is correct. Checks that need the declaration are skipped for that node
 * instead — see `validateFlowDefinition`.
 */
export type FlowNodeCapabilityResolver = (node: FlowNode) => FlowNodeCapabilities | null;

export type FlowValidationCode =
  | 'malformed'
  | 'duplicate-node-id'
  | 'edge-unknown-node'
  | 'edge-undeclared-output'
  | 'ambiguous-edge'
  | 'no-nodes'
  | 'no-start-node'
  | 'multiple-start-nodes';

export interface FlowValidationProblem {
  code: FlowValidationCode;
  /** Names the offending node or edge and says what to change, and why. */
  message: string;
  nodeId?: string;
  edge?: FlowEdge;
}

export class FlowValidationError extends Error {
  readonly problems: FlowValidationProblem[];

  constructor(problems: FlowValidationProblem[]) {
    super(problems.map((problem) => problem.message).join('\n'));
    this.name = 'FlowValidationError';
    this.problems = problems;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * The shape checks, kept separate because every check below assumes them. A
 * hand-written flow file is the normal way a definition arrives, so `{}` or a
 * `"1"` where a number belongs has to produce a sentence rather than a
 * TypeError from the first check that dereferences it.
 */
const structuralProblems = (flow: FlowDefinition): FlowValidationProblem[] => {
  const problems: FlowValidationProblem[] = [];
  const value = flow as unknown;

  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return [
      {
        code: 'malformed',
        message:
          'This is not a flow definition: a flow is an object with a "nodes" array and an ' +
          '"edges" array (either may be empty, but both must be present).',
      },
    ];
  }

  for (const [index, node] of value.nodes.entries()) {
    if (
      !isRecord(node) ||
      !isNonEmptyString(node.id) ||
      !isNonEmptyString(node.pluginId) ||
      typeof node.pluginVersion !== 'string' ||
      !isRecord(node.inputs)
    ) {
      problems.push({
        code: 'malformed',
        message:
          `Node at position ${index} is not a usable node. Every node needs a non-empty "id", ` +
          `a non-empty "pluginId", a "pluginVersion" string, and an "inputs" object.`,
      });
    }
  }

  for (const [index, edge] of value.edges.entries()) {
    if (
      !isRecord(edge) ||
      !isNonEmptyString(edge.fromNodeId) ||
      !isNonEmptyString(edge.toNodeId) ||
      typeof edge.outputNumber !== 'number' ||
      !Number.isInteger(edge.outputNumber)
    ) {
      problems.push({
        code: 'malformed',
        message:
          `Edge at position ${index} is not a usable edge. Every edge needs a "fromNodeId", a ` +
          `"toNodeId", and an integer "outputNumber" (a number, not a string — "1" never ` +
          `matches output 1, so that edge would simply never be taken).`,
      });
    }
  }

  return problems;
};

/**
 * Everything wrong with a flow, in the voice the CLI already uses: each
 * message names the offending node or edge, says what to change, and says
 * what the flow would have done if it ran as written — because every one of
 * these failures is silent at run time, and several of them end with the
 * library reporting its files converged.
 *
 * WHAT IS DELIBERATELY ALLOWED, and why:
 *
 *  - **Cycles.** A remediation branch that rejoins the main path is a cycle,
 *    and so is a deliberate retry loop; `runFlow` documents cycles as legal
 *    and bounds every flow with `DEFAULT_MAX_STEPS` instead. Forbidding them
 *    would reject the flows this system exists to express.
 *  - **Unreachable nodes.** An `onFlowError` handler is reached by no edge at
 *    all (`runFlow` finds it by `pType`), and authors park half-built or
 *    seasonally-used branches in a flow on purpose. `flowDefinitionHash`
 *    already hashes unreachable branches deliberately, so an unreachable node
 *    costs a re-evaluation, never a wrong result.
 *  - **A node whose plugin cannot be resolved here.** See
 *    `FlowNodeCapabilityResolver`. Its output numbers are unchecked, and it
 *    suppresses `no-start-node` entirely, because an unresolvable plugin may
 *    be the start plugin and "I could not check" is not "it is missing".
 *
 * WHAT IS REJECTED beyond the four required checks, and why:
 *
 *  - **More than one start node.** `runFlow` starts at the FIRST node in the
 *    array declaring `isStartPlugin`, while `flowDefinitionHash` sorts by id
 *    — so which node runs depends on array order while the flow's version
 *    does not. Two flows that run differently would share a signature, and
 *    the convergence decision would follow the JSON's array order.
 *  - **Two edges leaving the same output.** Same defect, one level down:
 *    `runFlow` takes the first matching edge in array order, and the hash
 *    sorts edges. Rejecting it also catches the accidental exact duplicate.
 */
export const validateFlowDefinition = (
  flow: FlowDefinition,
  resolveCapabilities?: FlowNodeCapabilityResolver,
): FlowValidationProblem[] => {
  const structural = structuralProblems(flow);
  if (structural.length > 0) return structural;

  const problems: FlowValidationProblem[] = [];

  if (flow.nodes.length === 0) {
    return [
      {
        code: 'no-nodes',
        message:
          'This flow has no nodes, so every file assigned to it would run an empty graph and ' +
          'be recorded as already converged without anything ever being examined. Add a start ' +
          'node and the steps you want it to drive.',
      },
    ];
  }

  // Duplicate ids. The executor indexes nodes by id, so this is the check
  // that keeps the running graph identical to the written one.
  const pluginIdsById = new Map<string, string[]>();
  for (const node of flow.nodes) {
    const existing = pluginIdsById.get(node.id);
    if (existing === undefined) pluginIdsById.set(node.id, [node.pluginId]);
    else existing.push(node.pluginId);
  }
  for (const [id, pluginIds] of pluginIdsById) {
    if (pluginIds.length < 2) continue;
    problems.push({
      code: 'duplicate-node-id',
      nodeId: id,
      message:
        `${pluginIds.length} nodes share the id "${id}" (${pluginIds.join(', ')}). Node ids ` +
        `must be unique: the executor indexes nodes by id, so all but one of these is silently ` +
        `dropped and the flow that runs is not the flow you wrote — with the files still ` +
        `reported as converged afterwards. Give each of them its own id and repoint the edges.`,
    });
  }

  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));

  // Edges pointing at a node that does not exist, and edges leaving one.
  for (const edge of flow.edges) {
    const from = nodesById.get(edge.fromNodeId);
    const to = nodesById.get(edge.toNodeId);
    if (from === undefined) {
      problems.push({
        code: 'edge-unknown-node',
        edge,
        message:
          `The edge from "${edge.fromNodeId}" output ${edge.outputNumber} to ` +
          `"${edge.toNodeId}" leaves a node that is not in this flow, so nothing can ever take ` +
          `it. Either add the node "${edge.fromNodeId}" or delete the edge — as written it ` +
          `hides a route the flow looks like it has.`,
      });
    }
    if (to === undefined) {
      problems.push({
        code: 'edge-unknown-node',
        edge,
        message:
          `The edge from "${edge.fromNodeId}" output ${edge.outputNumber} points at ` +
          `"${edge.toNodeId}", which is not a node in this flow. Add that node or repoint the ` +
          `edge: every file that reaches output ${edge.outputNumber} of "${edge.fromNodeId}" ` +
          `fails its run there, and does so once per attempt until its attempts are exhausted.`,
      });
    }
  }

  // Two edges leaving one output: array order alone would decide which wins.
  const edgesByOutput = new Map<string, FlowEdge[]>();
  for (const edge of flow.edges) {
    const key = `${edge.fromNodeId} ${edge.outputNumber}`;
    const existing = edgesByOutput.get(key);
    if (existing === undefined) edgesByOutput.set(key, [edge]);
    else existing.push(edge);
  }
  for (const edges of edgesByOutput.values()) {
    if (edges.length < 2) continue;
    const first = edges[0]!;
    const targets = edges.map((edge) => `"${edge.toNodeId}"`).join(', ');
    const identical = edges.every((edge) => edge.toNodeId === first.toNodeId);
    problems.push({
      code: 'ambiguous-edge',
      nodeId: first.fromNodeId,
      edge: first,
      message: identical
        ? `Output ${first.outputNumber} of "${first.fromNodeId}" has the same edge to ` +
          `${targets} ${edges.length} times. Keep one: a duplicate does nothing at run time, ` +
          `but it changes the flow's version hash, which re-queues every file in the library ` +
          `for no reason.`
        : `Output ${first.outputNumber} of "${first.fromNodeId}" has ${edges.length} edges ` +
          `leaving it, to ${targets}. An output goes to exactly one node: the executor would ` +
          `take whichever edge happens to come first in the JSON, while the flow's version ` +
          `hash ignores that order — so the route taken, and every convergence decision that ` +
          `follows from it, would depend on the order of an array. Keep one edge; if you want ` +
          `both paths, route one of them from a different output.`,
    });
  }

  if (resolveCapabilities === undefined) return problems;

  // Declared outputs and start nodes both need the plugin's own `details()`.
  const capabilitiesByNodeId = new Map<string, FlowNodeCapabilities | null>();
  for (const node of flow.nodes) {
    if (capabilitiesByNodeId.has(node.id)) continue;
    capabilitiesByNodeId.set(node.id, resolveCapabilities(node));
  }

  for (const edge of flow.edges) {
    const from = nodesById.get(edge.fromNodeId);
    if (from === undefined) continue; // Already reported above.
    const capabilities = capabilitiesByNodeId.get(from.id);
    if (capabilities === null || capabilities === undefined) continue; // Unresolvable: not our call.
    if (capabilities.outputNumbers.includes(edge.outputNumber)) continue;
    problems.push({
      code: 'edge-undeclared-output',
      nodeId: from.id,
      edge,
      message:
        `The edge from "${from.id}" uses output ${edge.outputNumber}, but ` +
        `"${from.pluginId}" declares only output(s) ${capabilities.outputNumbers.join(', ')}. ` +
        `Repoint it at one of those: an edge on an output the node never takes is a route that ` +
        `never runs, so the branch you drew is dead and the file stops at that node instead — ` +
        `which is recorded as the file having converged, exactly as written.`,
    });
  }

  // By distinct id, not by array position: a duplicated id is ONE entry in the
  // capability map, and counting it once per array element would report a
  // duplicated start node as "two start nodes" — a second, wrong diagnosis on
  // top of the duplicate-id problem already reported above.
  const uniqueNodes = flow.nodes.filter(
    (node, index) => flow.nodes.findIndex((other) => other.id === node.id) === index,
  );
  const startNodeIds = uniqueNodes
    .filter((node) => capabilitiesByNodeId.get(node.id)?.isStartPlugin === true)
    .map((node) => node.id);
  const unresolvable = uniqueNodes.filter((node) => capabilitiesByNodeId.get(node.id) == null);

  if (startNodeIds.length > 1) {
    problems.push({
      code: 'multiple-start-nodes',
      nodeId: startNodeIds[0],
      message:
        `This flow has ${startNodeIds.length} start nodes (${startNodeIds
          .map((id) => `"${id}"`)
          .join(', ')}). A flow starts in exactly one place: the executor would begin at ` +
        `whichever of them comes first in the JSON, while the flow's version hash ignores that ` +
        `order — so which half of the flow ever runs, and every convergence decision that ` +
        `follows, would depend on the order of an array. Keep one start node.`,
    });
  } else if (startNodeIds.length === 0 && unresolvable.length === 0) {
    problems.push({
      code: 'no-start-node',
      message:
        `This flow has no start node, so nothing in it can ever run: every file assigned to it ` +
        `fails its run immediately, once per attempt, until its attempts are exhausted. Add a ` +
        `start node (a plugin whose details() sets isStartPlugin, e.g. "trawlarr:start") and ` +
        `route it into the first step you want.`,
    });
  }

  return problems;
};

/**
 * `validateFlowDefinition`, as a gate. Reject rather than repair: a repaired
 * flow is a flow its author did not write, running unattended over a library.
 */
export const assertFlowDefinitionValid = (
  flow: FlowDefinition,
  resolveCapabilities?: FlowNodeCapabilityResolver,
): void => {
  const problems = validateFlowDefinition(flow, resolveCapabilities);
  if (problems.length > 0) throw new FlowValidationError(problems);
};
