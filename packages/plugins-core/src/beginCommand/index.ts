import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from '@trawlarr/core';

export const details = (): PluginDetails => ({
  name: 'Begin Command',
  description:
    'Start building an ffmpeg command. Command-building nodes must come after this, ' +
    'and an Execute node must follow them.',
  style: { borderColor: '#cc9933' },
  tags: 'ffmpeg',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 2,
  icon: 'faPlay',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'Command started' }],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): PluginOutputArgs => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: {
    ...args.variables,
    ffmpegCommand: beginFfmpegCommand({
      probe: args.inputFileObj.ffProbeData,
      container: args.inputFileObj.container,
      inputPath: args.inputFileObj._id,
    }),
  },
});
