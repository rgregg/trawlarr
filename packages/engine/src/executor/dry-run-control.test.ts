import { expect, it, vi } from 'vitest';
import type { PluginDetails, PluginInputArgs, PluginModule } from '@trawlarr/plugin-api';
import { runDryFlow } from './dry-run.js';

it('does not route a dry-run refusal into an error handler and pretend the walk completed', async () => {
  const metadata: PluginDetails = {
    name: 'Test node',
    description: '',
    style: { borderColor: '#000' },
    tags: '',
    isStartPlugin: false,
    pType: 'onFlowError',
    sidebarPosition: 0,
    icon: '',
    inputs: [],
    outputs: [{ number: 1, tooltip: 'Continue' }],
    requiresVersion: '1.0.0',
  };
  const invoke = vi.fn<PluginModule['plugin']>((args) => ({
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  }));
  const result = await runDryFlow({
    flow: {
      nodes: [
        { id: 'unvouched', pluginId: 'community:unknown', pluginVersion: '1', inputs: {} },
        { id: 'handler', pluginId: 'trawlarr:start', pluginVersion: '1', inputs: {} },
      ],
      edges: [],
    },
    startNodeId: 'unvouched',
    initialPath: '/library/movie.mkv',
    outputPathFor: (path) => `${path}.output.mkv`,
    loadPlugin: (node) => ({
      id: node.pluginId,
      absPath: '/fixture/index.js',
      version: '1',
      details: metadata,
      module: { details: () => metadata, plugin: invoke },
    }),
    buildArgs: (invocation) =>
      ({
        inputFileObj: { _id: invocation.currentPath },
        variables: invocation.variables,
        jobLog: () => {},
      }) as unknown as PluginInputArgs,
  });
  expect(result.complete).toBe(false);
  expect(result.stoppedAtNodeId).toBe('unvouched');
  expect(result.steps.map((step) => step.nodeId)).toEqual(['unvouched']);
  expect(invoke).not.toHaveBeenCalled();
});
