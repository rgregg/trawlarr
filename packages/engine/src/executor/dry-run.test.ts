import { describe, expect, it } from 'vitest';
import type { FlowDefinition, FlowNode } from '@trawlarr/core';
import type { PluginDetails, PluginInputArgs, PluginModule } from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';
import { beginFfmpegCommand } from '@trawlarr/core';
import { classifySideEffects } from './vouchable.js';
import { runDryFlow } from './dry-run.js';

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
  outputs: [{ number: 1, tooltip: '' }],
  requiresVersion: '2.11.01',
  ...over,
});

const loaded = (id: string, module: PluginModule): LoadedPlugin => ({
  id,
  absPath: `/plugins/${id}.js`,
  version: '1.0.0',
  details: details({ name: id }),
  module,
});

const pass: PluginModule = {
  details: () => details(),
  plugin: (args) => ({
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  }),
};

const beginAndEncode: PluginModule = {
  details: () => details(),
  plugin: (args) => {
    const command = beginFfmpegCommand({
      probe: { streams: [{ codec_type: 'video', codec_name: 'h264' }] },
      container: 'mkv',
      inputPath: args.inputFileObj._id,
    });
    command.streams[0]!.outputArgs.push('-c:v', 'hevc_nvenc');
    command.shouldProcess = true;
    return {
      outputNumber: 1,
      outputFileObj: { _id: args.inputFileObj._id },
      variables: { ...args.variables, ffmpegCommand: command },
    };
  },
};

const node = (id: string, pluginId: string): FlowNode => ({
  id,
  pluginId,
  pluginVersion: '1.0.0',
  inputs: {},
});

const flow = (nodes: FlowNode[], edges: FlowDefinition['edges']): FlowDefinition => ({
  nodes,
  edges,
});

const buildArgs = (invocation: { currentPath: string; variables: unknown }) =>
  ({
    inputFileObj: { _id: invocation.currentPath },
    variables: invocation.variables,
    inputs: {},
    jobLog: () => {},
  }) as unknown as PluginInputArgs;

const base = {
  initialPath: '/in.mkv',
  startNodeId: 'a',
  buildArgs,
  outputPathFor: (path: string, container: string) => `/staging/out.${container}`,
};

describe('classifySideEffects', () => {
  it('knows first-party filters are inert', () => {
    expect(classifySideEffects(loaded('trawlarr:checkVideoCodec', pass))).toBe('inert');
  });

  it('knows the Execute node is engine-controlled', () => {
    expect(classifySideEffects(loaded('trawlarr:execute', pass))).toBe('engine-controlled');
  });

  it('treats anything unrecognised as unknown, which is the safe default', () => {
    expect(classifySideEffects(loaded('community:mysteryNode', pass))).toBe('unknown');
  });

  it('classifies a path-hash id (from createPluginLoader) as unknown', () => {
    // createPluginLoader produces 16-hex-char ids via SHA-256.slice(0, 16)
    // These will never match the trawlarr:* allowlists, so they correctly classify as unknown.
    const hashId = 'a1b2c3d4e5f6a1b2';
    expect(classifySideEffects(loaded(hashId, pass))).toBe('unknown');
  });
});

describe('runDryFlow', () => {
  it('completes a flow built only from first-party nodes', async () => {
    const result = await runDryFlow({
      ...base,
      flow: flow(
        [node('a', 'trawlarr:checkVideoCodec'), node('b', 'trawlarr:setVideoEncoder')],
        [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
      ),
      loadPlugin: (n) => loaded(n.pluginId, pass),
    });

    expect(result.complete).toBe(true);
    expect(result.stoppedAtNodeId).toBeNull();
    expect(result.steps).toHaveLength(2);
  });

  it('records the ffmpeg command Execute would have run, without running it', async () => {
    const result = await runDryFlow({
      ...base,
      flow: flow(
        [node('a', 'trawlarr:beginCommand'), node('b', 'trawlarr:execute')],
        [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
      ),
      loadPlugin: (n) =>
        loaded(n.pluginId, n.pluginId === 'trawlarr:beginCommand' ? beginAndEncode : pass),
    });

    expect(result.complete).toBe(true);
    expect(result.plannedCommands).toHaveLength(1);
    expect(result.plannedCommands[0]).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-c:v',
      'hevc_nvenc',
      '/staging/out.mkv',
    ]);
  });

  it('stops at an unrecognised node and says which one and why', async () => {
    const result = await runDryFlow({
      ...base,
      flow: flow(
        [node('a', 'trawlarr:checkVideoCodec'), node('b', 'community:mysteryNode')],
        [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
      ),
      loadPlugin: (n) => loaded(n.pluginId, pass),
    });

    expect(result.complete).toBe(false);
    expect(result.stoppedAtNodeId).toBe('b');
    expect(result.stoppedBecause).toMatch(/community:mysteryNode/);
    expect(result.stoppedBecause).toMatch(/side effects/i);
  });

  it('does not invoke the unrecognised plugin at all', async () => {
    let invoked = false;
    const spy: PluginModule = {
      details: () => details(),
      plugin: (args) => {
        invoked = true;
        return {
          outputNumber: 1,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: args.variables,
        };
      },
    };
    await runDryFlow({
      ...base,
      flow: flow([node('a', 'community:mysteryNode')], []),
      loadPlugin: (n) => loaded(n.pluginId, spy),
    });
    expect(invoked).toBe(false);
  });

  it('reports stopping early as incomplete rather than as a failure', async () => {
    const result = await runDryFlow({
      ...base,
      flow: flow([node('a', 'community:mysteryNode')], []),
      loadPlugin: (n) => loaded(n.pluginId, pass),
    });
    // The flow did not fail; we declined to continue. The distinction matters
    // because a dry run stopping early is normal, not an error to fix.
    expect(result.failed).toBe(false);
    expect(result.complete).toBe(false);
  });

  it('stops at a node with a path-hash id, with complete: false and failed: false', async () => {
    const hashId = 'a1b2c3d4e5f6a1b2';
    const result = await runDryFlow({
      ...base,
      flow: flow(
        [node('a', 'trawlarr:checkVideoCodec'), node('b', hashId)],
        [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
      ),
      loadPlugin: (n) => loaded(n.pluginId, pass),
    });

    // Third-party plugins loaded from disk via createPluginLoader get hash ids
    // and correctly classify as unknown, so the dry run stops.
    expect(result.complete).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.stoppedAtNodeId).toBe('b');
  });
});
