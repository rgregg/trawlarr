import { describe, expect, it, vi } from 'vitest';
import type { FlowDefinition, FlowNode } from '@trawlarr/core';
import type {
  PluginDetails,
  PluginInputArgs,
  PluginModule,
  RunVariables,
} from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';
import { DEFAULT_MAX_STEPS, runFlow } from './run-flow.js';

const details = (over: Partial<PluginDetails> = {}): PluginDetails => ({
  name: 'Node',
  description: '',
  style: { borderColor: '#000' },
  tags: '',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: '',
  inputs: [],
  outputs: [
    { number: 1, tooltip: '' },
    { number: 2, tooltip: '' },
  ],
  requiresVersion: '2.11.01',
  ...over,
});

/** Build a loader over a map of node id -> plugin behaviour. */
const loaderFor =
  (behaviours: Record<string, { module: PluginModule; details?: PluginDetails }>) =>
  (node: FlowNode): LoadedPlugin => {
    const entry = behaviours[node.pluginId];
    if (entry === undefined) throw new Error(`no fixture for plugin ${node.pluginId}`);
    return {
      id: node.pluginId,
      absPath: `/fixtures/${node.pluginId}.js`,
      version: node.pluginVersion,
      details: entry.details ?? details(),
      module: entry.module,
    };
  };

const routeTo = (outputNumber: number): PluginModule => ({
  details: () => details(),
  plugin: (args) => ({
    outputNumber,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  }),
});

const buildArgs = (invocation: { currentPath: string; variables: RunVariables }): PluginInputArgs =>
  ({
    inputFileObj: { _id: invocation.currentPath },
    variables: invocation.variables,
    inputs: {},
    jobLog: () => {},
  }) as unknown as PluginInputArgs;

const flow = (nodes: FlowNode[], edges: FlowDefinition['edges']): FlowDefinition => ({
  nodes,
  edges,
});

const node = (id: string, pluginId = id, isStart = false): FlowNode => ({
  id,
  pluginId,
  pluginVersion: '1.0.0',
  inputs: isStart ? { __start: true } : {},
});

describe('runFlow — routing', () => {
  it('walks a linear flow and records a step per node', async () => {
    const result = await runFlow({
      flow: flow([node('a'), node('b')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) }, b: { module: routeTo(1) } }),
      buildArgs,
    });

    expect(result.failed).toBe(false);
    expect(result.stopReason).toBe('end-of-flow');
    expect(result.steps.map((s) => s.nodeId)).toEqual(['a', 'b']);
    expect(result.steps.map((s) => s.seq)).toEqual([1, 2]);
  });

  it('follows the edge matching the returned output number', async () => {
    const result = await runFlow({
      flow: flow(
        [node('a'), node('yes'), node('no')],
        [
          { fromNodeId: 'a', outputNumber: 1, toNodeId: 'yes' },
          { fromNodeId: 'a', outputNumber: 2, toNodeId: 'no' },
        ],
      ),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({
        a: { module: routeTo(2) },
        yes: { module: routeTo(1) },
        no: { module: routeTo(1) },
      }),
      buildArgs,
    });

    expect(result.steps.map((s) => s.nodeId)).toEqual(['a', 'no']);
  });

  it('ends cleanly when the chosen output has no edge', async () => {
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
    });
    expect(result.stopReason).toBe('end-of-flow');
    expect(result.failed).toBe(false);
  });

  it('finds the start node from details().isStartPlugin when none is named', async () => {
    const result = await runFlow({
      flow: flow(
        [node('a'), node('start')],
        [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'a' }],
      ),
      initialPath: '/in.mkv',
      loadPlugin: loaderFor({
        a: { module: routeTo(1) },
        start: { module: routeTo(1), details: details({ isStartPlugin: true }) },
      }),
      buildArgs,
    });
    expect(result.steps[0]?.nodeId).toBe('start');
  });

  it('fails clearly when there is no start node at all', async () => {
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
    });
    expect(result.stopReason).toBe('no-start-node');
    expect(result.failed).toBe(true);
    expect(result.error).toMatch(/start/i);
  });

  it('fails when an edge points at a node that is not in the flow', async () => {
    const result = await runFlow({
      flow: flow([node('a')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'ghost' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
    });
    expect(result.stopReason).toBe('missing-node');
    expect(result.error).toMatch(/ghost/);
  });
});

describe('runFlow — cycles', () => {
  it('permits a cycle, because real community flows contain them', async () => {
    let visits = 0;
    const loop: PluginModule = {
      details: () => details(),
      plugin: (args) => {
        visits += 1;
        return {
          outputNumber: visits < 3 ? 1 : 2,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: args.variables,
        };
      },
    };

    const result = await runFlow({
      flow: flow(
        [node('a'), node('done')],
        [
          { fromNodeId: 'a', outputNumber: 1, toNodeId: 'a' },
          { fromNodeId: 'a', outputNumber: 2, toNodeId: 'done' },
        ],
      ),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: loop }, done: { module: routeTo(1) } }),
      buildArgs,
    });

    expect(visits).toBe(3);
    expect(result.steps).toHaveLength(4);
    expect(result.failed).toBe(false);
  });

  it('stops an endless cycle at the step budget instead of hanging', async () => {
    const result = await runFlow({
      flow: flow([node('a')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'a' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
      maxSteps: 10,
    });
    expect(result.stopReason).toBe('step-budget');
    expect(result.failed).toBe(true);
    expect(result.steps).toHaveLength(10);
    expect(result.error).toMatch(/10/);
  });

  it('has a default budget', () => {
    expect(DEFAULT_MAX_STEPS).toBe(500);
  });
});

describe('runFlow — errors', () => {
  const boom: PluginModule = {
    details: () => details(),
    plugin: () => {
      throw new Error('plugin exploded');
    },
  };

  it('fails the run and records the error on the step', async () => {
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: boom } }),
      buildArgs,
    });
    expect(result.failed).toBe(true);
    expect(result.stopReason).toBe('plugin-error');
    expect(result.steps[0]?.error).toMatch(/plugin exploded/);
    expect(result.variables.flowFailed).toBe(true);
  });

  it('routes to an onFlowError node when the flow has one', async () => {
    const result = await runFlow({
      flow: flow([node('a'), node('handler')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({
        a: { module: boom },
        handler: { module: routeTo(1), details: details({ pType: 'onFlowError' }) },
      }),
      buildArgs,
    });
    expect(result.steps.map((s) => s.nodeId)).toEqual(['a', 'handler']);
    expect(result.variables.flowFailed).toBe(true);
  });

  it('does not loop when the error handler itself throws', async () => {
    const result = await runFlow({
      flow: flow([node('a'), node('handler')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({
        a: { module: boom },
        handler: { module: boom, details: details({ pType: 'onFlowError' }) },
      }),
      buildArgs,
    });
    expect(result.steps).toHaveLength(2);
    expect(result.failed).toBe(true);
  });

  it('fails the run when a plugin returns nothing usable', async () => {
    const bad: PluginModule = {
      details: () => details(),
      plugin: () => undefined as never,
    };
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: bad } }),
      buildArgs,
    });
    expect(result.failed).toBe(true);
    expect(result.steps[0]?.error).toMatch(/outputNumber/i);
  });

  it('fails the run when a plugin cannot be loaded', async () => {
    const result = await runFlow({
      flow: flow([node('a', 'missing-plugin')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({}),
      buildArgs,
    });
    expect(result.failed).toBe(true);
    expect(result.error).toMatch(/missing-plugin/);
  });
});

describe('runFlow — state threading', () => {
  it('threads a path change from one node into the next', async () => {
    const rename: PluginModule = {
      details: () => details(),
      plugin: (args) => ({
        outputNumber: 1,
        outputFileObj: { _id: '/out.mp4' },
        variables: args.variables,
      }),
    };
    const seen: string[] = [];

    const result = await runFlow({
      flow: flow([node('a'), node('b')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: rename }, b: { module: routeTo(1) } }),
      buildArgs: (invocation) => {
        seen.push(invocation.currentPath);
        return buildArgs(invocation);
      },
    });

    expect(seen).toEqual(['/in.mkv', '/out.mp4']);
    expect(result.currentPath).toBe('/out.mp4');
  });

  it('threads mutated variables forward, which is how ffmpegCommand cooperation works', async () => {
    const setter: PluginModule = {
      details: () => details(),
      plugin: (args) => {
        args.variables.ffmpegCommand.init = true;
        args.variables.ffmpegCommand.container = 'mkv';
        return {
          outputNumber: 1,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: args.variables,
        };
      },
    };

    const result = await runFlow({
      flow: flow([node('a'), node('b')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: setter }, b: { module: routeTo(1) } }),
      buildArgs,
    });

    expect(result.variables.ffmpegCommand.init).toBe(true);
    expect(result.variables.ffmpegCommand.container).toBe('mkv');
  });

  it('awaits async plugins', async () => {
    const slow: PluginModule = {
      details: () => details(),
      plugin: async (args) => {
        await Promise.resolve();
        return {
          outputNumber: 1,
          outputFileObj: { _id: '/async.mkv' },
          variables: args.variables,
        };
      },
    };
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: slow } }),
      buildArgs,
    });
    expect(result.currentPath).toBe('/async.mkv');
  });

  it('emits steps as they happen for live progress', async () => {
    const onStep = vi.fn();
    await runFlow({
      flow: flow([node('a'), node('b')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) }, b: { module: routeTo(1) } }),
      buildArgs,
      onStep,
    });
    expect(onStep).toHaveBeenCalledTimes(2);
    expect(onStep.mock.calls[0]![0]).toMatchObject({ seq: 1, nodeId: 'a' });
  });

  it('records step durations from the injected clock', async () => {
    let clock = 1000;
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
      nowMs: () => {
        clock += 250;
        return clock;
      },
    });
    expect(result.steps[0]?.durationMs).toBe(250);
  });
});
