import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { assertCommandInitialised } from '@trawlarr/core';

export const details = (): PluginDetails => ({
  name: 'Execute',
  description: 'Run the ffmpeg command built by the preceding nodes.',
  style: { borderColor: '#cc3333' },
  tags: 'ffmpeg',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 4,
  icon: 'faBolt',
  inputs: [],
  outputs: [
    { number: 1, tooltip: 'Command succeeded' },
    { number: 2, tooltip: 'Command failed', outcome: 'failure' },
  ],
  requiresVersion: '1.0.0',
});

/**
 * The engine performs the actual execution and replaces this module's behaviour
 * at runtime, which is what lets a dry run record the planned command without
 * running it. Reaching this body means the node ran outside an engine that
 * understands it.
 */
export const plugin = (args: PluginInputArgs): PluginOutputArgs => {
  assertCommandInitialised(args.variables.ffmpegCommand);
  throw new Error(
    'The Execute node must be run by the trawlarr engine, which performs the ffmpeg ' +
      'invocation itself. This usually means the engine did not register its executor.',
  );
};
