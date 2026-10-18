import { describe, expect, it, vi } from 'vitest';
import type { ConfigVars, PluginDeps, PluginFileObject } from '@trawlarr/plugin-api';
import { buildPluginInputArgs, type BuildArgsInput } from './args.js';

const file = { _id: '/in.mkv' } as unknown as PluginFileObject;

const input = (over: Partial<BuildArgsInput> = {}): BuildArgsInput => ({
  fileObject: file,
  originalFileObject: file,
  nodeInputs: {},
  variables: {} as BuildArgsInput['variables'],
  librarySettings: {},
  userVariables: { global: {}, library: {} },
  configVars: {
    config: {
      platform_arch_isdocker: 'linux_x64_docker_false',
      ffmpegPath: 'ffmpeg',
      handbrakePath: '',
      mkvpropeditPath: '',
    },
  } as unknown as ConfigVars,
  deps: {} as PluginDeps,
  workDir: '/work',
  jobId: 'j',
  footprintId: 'f',
  fileId: 'i',
  jobStartMs: 0,
  workerClass: 'transcode',
  hardwareType: 'cpu',
  log: () => {},
  ...over,
});

describe('buildPluginInputArgs sendAlert', () => {
  it('passes sendAlert through when provided', () => {
    const sendAlert = vi.fn();
    const args = buildPluginInputArgs(input({ sendAlert }));
    args.sendAlert!('ha', 'hi');
    expect(sendAlert).toHaveBeenCalledOnce();
    expect(sendAlert).toHaveBeenCalledWith('ha', 'hi');
  });

  it('leaves sendAlert undefined otherwise, as Tdarr does', () => {
    expect(buildPluginInputArgs(input()).sendAlert).toBeUndefined();
  });

  it('never throws into the plugin and hands back nothing to await', () => {
    const args = buildPluginInputArgs(
      input({
        sendAlert: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(args.sendAlert!('ha', 'hi')).toBeUndefined();
  });

  it('swallows a rejected promise from a port that returns one', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const port = (() => Promise.reject(new Error('late'))) as unknown as (
      d: string,
      m: string,
    ) => void;
    const args = buildPluginInputArgs(input({ sendAlert: port }));
    expect(args.sendAlert!('ha', 'hi')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
