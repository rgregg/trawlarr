import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';

export const details = (): PluginDetails => ({
  name: 'Check Size Change',
  description: 'Branch on whether the new file is within a size limit relative to the original.',
  style: { borderColor: '#33aa66' },
  tags: 'safety,size',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 5,
  icon: 'faWeightHanging',
  inputs: [
    {
      name: 'maxSizePercent',
      label: 'Maximum size (% of original)',
      type: 'number',
      defaultValue: '101',
      tooltip:
        'The largest the new file may be. 101 allows 1% growth; raise it for a flow that adds ' +
        'tracks on purpose, lower it below 100 to require a saving.',
      inputUI: { type: 'text' },
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Within the size limit' },
    { number: 2, tooltip: 'Larger than allowed' },
  ],
  requiresVersion: '1.0.0',
});

/**
 * The engine measures both files and replaces this module's behaviour at
 * runtime (`size-change.ts`), which is also what lets a dry run pass through
 * it. Reaching this body means the node ran outside an engine that
 * understands it.
 */
export const plugin = async (args: PluginInputArgs): Promise<PluginOutputArgs> => {
  args.jobLog('Check Size Change must be run by the trawlarr engine; refusing to run standalone.');
  throw new Error(
    'The Check Size Change node must be run by the trawlarr engine, which measures the files ' +
      'itself. This usually means the engine did not register its executor.',
  );
};
