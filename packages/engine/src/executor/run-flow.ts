import type { FlowDefinition, FlowNode } from '@trawlarr/core';
import type { PluginInputArgs, RunVariables } from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';

export interface StepRecord {
  seq: number;
  nodeId: string;
  pluginId: string;
  pluginName: string;
  outputNumber: number | null;
  durationMs: number;
  logExcerpt: string;
  error: string | null;
}

export type StopReason =
  'end-of-flow' | 'plugin-error' | 'step-budget' | 'missing-node' | 'no-start-node';

export interface FlowRunResult {
  steps: StepRecord[];
  variables: RunVariables;
  currentPath: string;
  failed: boolean;
  stopReason: StopReason;
  error: string | null;
}

export interface NodeInvocation {
  node: FlowNode;
  plugin: LoadedPlugin;
  currentPath: string;
  variables: RunVariables;
  seq: number;
}

export interface RunFlowOptions {
  flow: FlowDefinition;
  initialPath: string;
  loadPlugin: (node: FlowNode) => LoadedPlugin;
  buildArgs: (invocation: NodeInvocation) => PluginInputArgs;
  startNodeId?: string;
  maxSteps?: number;
  onStep?: (step: StepRecord) => void;
  nowMs?: () => number;
}

/**
 * Cycles are legal, so termination cannot come from cycle detection. A step
 * budget bounds any flow, including intentional loops, without forbidding them.
 */
export const DEFAULT_MAX_STEPS = 500;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const runFlow = async (options: RunFlowOptions): Promise<FlowRunResult> => {
  const nowMs = options.nowMs ?? (() => Date.now());
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  const nodesById = new Map(options.flow.nodes.map((node) => [node.id, node]));
  const steps: StepRecord[] = [];

  let variables: RunVariables = {
    ffmpegCommand: {
      init: false,
      inputFiles: [],
      streams: [],
      container: '',
      hardwareDecoding: false,
      shouldProcess: false,
      overallInputArguments: [],
      overallOuputArguments: [],
    },
    flowFailed: false,
    user: {},
  };
  let currentPath = options.initialPath;

  const finish = (stopReason: StopReason, error: string | null): FlowRunResult => ({
    steps,
    variables,
    currentPath,
    failed: stopReason !== 'end-of-flow',
    stopReason,
    error,
  });

  // Memoise loads for this run only: discovery (findStartNode / findErrorHandler) and the
  // main loop both need a node's LoadedPlugin, and without this each node the discovery
  // step touches gets loaded a second time when it's actually executed. This does not
  // replace the loader's own cross-run cache — it just avoids doing the loader's work twice
  // within a single runFlow call.
  const loadedByNodeId = new Map<string, LoadedPlugin>();
  const loadPluginOnce = (node: FlowNode): LoadedPlugin => {
    const cached = loadedByNodeId.get(node.id);
    if (cached !== undefined) return cached;
    const loaded = options.loadPlugin(node);
    loadedByNodeId.set(node.id, loaded);
    return loaded;
  };

  // Discovery must keep going when some unrelated node fails to load, but it must not
  // silently swallow the failure of the node that actually is the flow's start node — that
  // would misreport a broken plugin as "no start node". So load failures are collected here
  // and only surfaced if discovery comes up empty.
  const startDiscoveryLoadErrors: { nodeId: string; pluginId: string; message: string }[] = [];

  const findStartNode = (): FlowNode | undefined => {
    if (options.startNodeId !== undefined) return nodesById.get(options.startNodeId);
    return options.flow.nodes.find((node) => {
      try {
        return loadPluginOnce(node).details.isStartPlugin === true;
      } catch (error) {
        startDiscoveryLoadErrors.push({
          nodeId: node.id,
          pluginId: node.pluginId,
          message: messageOf(error),
        });
        return false;
      }
    });
  };

  const findErrorHandler = (): FlowNode | undefined =>
    options.flow.nodes.find((node) => {
      try {
        return loadPluginOnce(node).details.pType === 'onFlowError';
      } catch {
        return false;
      }
    });

  let current = findStartNode();
  if (current === undefined) {
    if (startDiscoveryLoadErrors.length > 0) {
      const failures = startDiscoveryLoadErrors
        .map(
          (failure) =>
            `plugin "${failure.pluginId}" (node "${failure.nodeId}"): ${failure.message}`,
        )
        .join('; ');
      return finish(
        'no-start-node',
        `Could not determine the flow's start node because one or more nodes failed to load: ${failures}`,
      );
    }
    return finish(
      'no-start-node',
      'This flow has no start node. Mark a node as the start, or pass an explicit start node id.',
    );
  }

  let errorHandlerUsed = false;

  for (;;) {
    if (steps.length >= maxSteps) {
      return finish(
        'step-budget',
        `Flow exceeded its budget of ${maxSteps} steps, which usually means a loop that ` +
          `never reaches an exit condition.`,
      );
    }

    const node: FlowNode = current;
    const seq = steps.length + 1;
    const startedAt = nowMs();

    let plugin: LoadedPlugin;
    try {
      plugin = loadPluginOnce(node);
    } catch (error) {
      const step: StepRecord = {
        seq,
        nodeId: node.id,
        pluginId: node.pluginId,
        pluginName: node.pluginId,
        outputNumber: null,
        durationMs: nowMs() - startedAt,
        logExcerpt: '',
        error: messageOf(error),
      };
      steps.push(step);
      options.onStep?.(step);
      variables = { ...variables, flowFailed: true };
      return finish('plugin-error', messageOf(error));
    }

    const logLines: string[] = [];
    const invocation: NodeInvocation = { node, plugin, currentPath, variables, seq };
    const args = options.buildArgs(invocation);
    const originalJobLog = args.jobLog;
    args.jobLog = (text: string) => {
      logLines.push(text);
      originalJobLog?.(text);
    };

    let outputNumber: number | null = null;
    let stepError: string | null = null;

    try {
      const output = await plugin.module.plugin(args);
      if (output === null || output === undefined || typeof output.outputNumber !== 'number') {
        throw new Error(
          `Plugin "${plugin.details.name}" did not return an outputNumber. A flow plugin ` +
            `must return { outputNumber, outputFileObj, variables }.`,
        );
      }
      outputNumber = output.outputNumber;
      if (typeof output.outputFileObj?._id === 'string' && output.outputFileObj._id !== '') {
        currentPath = output.outputFileObj._id;
      }
      if (output.variables !== undefined) variables = output.variables;
    } catch (error) {
      stepError = messageOf(error);
    }

    const step: StepRecord = {
      seq,
      nodeId: node.id,
      pluginId: node.pluginId,
      pluginName: plugin.details.name,
      outputNumber,
      durationMs: nowMs() - startedAt,
      logExcerpt: logLines.join('\n'),
      error: stepError,
    };
    steps.push(step);
    options.onStep?.(step);

    if (stepError !== null) {
      variables = { ...variables, flowFailed: true };

      // One attempt at the error handler. If it throws too, stop — retrying a
      // failing handler is how a failure becomes an infinite loop.
      if (!errorHandlerUsed) {
        const handler = findErrorHandler();
        if (handler !== undefined && handler.id !== node.id) {
          errorHandlerUsed = true;
          current = handler;
          continue;
        }
      }
      return finish('plugin-error', stepError);
    }

    const edge = options.flow.edges.find(
      (candidate) => candidate.fromNodeId === node.id && candidate.outputNumber === outputNumber,
    );
    if (edge === undefined) return finish('end-of-flow', null);

    const next = nodesById.get(edge.toNodeId);
    if (next === undefined) {
      return finish(
        'missing-node',
        `Flow edge from "${node.id}" points at "${edge.toNodeId}", which is not in this flow.`,
      );
    }
    current = next;
  }
};
