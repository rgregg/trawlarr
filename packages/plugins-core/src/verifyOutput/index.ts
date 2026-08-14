import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';

export const details = (): PluginDetails => ({
  name: 'Verify Output',
  description:
    'Check that a transcode actually produced a sound file before anything downstream ' +
    'trusts it: the output probes cleanly, its duration and stream count match the ' +
    'original within tolerance, and its size is sane.',
  style: { borderColor: '#33aa66' },
  tags: 'safety,verify',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 5,
  icon: 'faShieldHalved',
  inputs: [
    {
      label: 'Duration tolerance (seconds)',
      name: 'durationToleranceSeconds',
      type: 'string',
      defaultValue: '1',
      tooltip:
        'How many seconds the output duration may differ from the original before this ' +
        'is treated as a failed transcode.',
      inputUI: { type: 'text' },
    },
    {
      label: 'Minimum size ratio',
      name: 'minSizeRatio',
      type: 'string',
      defaultValue: '0.05',
      tooltip:
        'The smallest fraction of the original file size the output may be. A 40 GB file ' +
        'becoming 200 MB is a failure, not a success — this is the sanity floor.',
      inputUI: { type: 'text' },
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Output verified: probes cleanly and matches expectations' },
    { number: 2, tooltip: 'Verification failed: output did not meet the checks above' },
  ],
  requiresVersion: '1.0.0',
});

/**
 * The engine performs the actual verification (probing the output and
 * comparing its stream count, duration and size against the original) and
 * replaces this module's behaviour at runtime, which is what lets a dry run
 * record the planned check without touching the filesystem. Reaching this
 * body means the node ran outside an engine that understands it.
 *
 * Free space and hardlink state are NOT checked here: the hardlink refusal
 * belongs to Replace Original File, which is the node that would act on it.
 */
export const plugin = async (args: PluginInputArgs): Promise<PluginOutputArgs> => {
  args.jobLog('Verify Output must be run by the trawlarr engine; refusing to run standalone.');
  throw new Error(
    'The Verify Output node must be run by the trawlarr engine, which performs the output ' +
      'verification itself. This usually means the engine did not register its executor.',
  );
};
