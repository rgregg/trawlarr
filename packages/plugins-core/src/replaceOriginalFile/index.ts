import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';

export const details = (): PluginDetails => ({
  name: 'Replace Original File',
  description:
    'Replace the original file with the new one produced upstream: the original moves to ' +
    'the library trash and the new file takes its place. Companion files (subtitles, .nfo) ' +
    'are not trashed — they follow the new file to its name. This is the destructive step ' +
    '— the engine never replaces a file implicitly, only when this node is placed in the flow.',
  style: { borderColor: '#aa3333' },
  tags: 'safety,replace',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 6,
  icon: 'faRightLeft',
  inputs: [
    {
      label: 'Trash retention (days)',
      name: 'trashRetentionDays',
      type: 'string',
      defaultValue: '14',
      tooltip:
        'How many days the replaced original should be retained in the library trash. ' +
        'Automatic purging is not implemented yet, so the trash accumulates until it is ' +
        'cleared manually — this value records intent, it does not yet trigger cleanup.',
      inputUI: { type: 'text' },
    },
    {
      label: 'Allow cross-device fallback',
      name: 'allowCrossDevice',
      type: 'boolean',
      defaultValue: 'true',
      tooltip:
        'If the staging area is on a different filesystem than the library, an atomic ' +
        'rename is not possible. When allowed, the engine falls back to copying the new ' +
        'file to a temporary location on the destination filesystem and finishing with an ' +
        'atomic rename, so an interrupted copy can never leave a truncated file where the ' +
        'original used to be; this is reported in the step trace. When disallowed, ' +
        'cross-device replacement fails this node instead.',
      inputUI: { type: 'switch' },
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Original replaced successfully' },
    { number: 2, tooltip: 'Replacement failed', outcome: 'failure' },
  ],
  requiresVersion: '1.0.0',
});

/**
 * The engine performs the actual filesystem replacement (moving the original
 * to trash, installing the new file in its place, and renaming companion
 * files to follow it) and replaces this module's behaviour at runtime, which
 * is what lets a dry run record the planned replacement without touching the
 * filesystem. Reaching this body means the node ran outside an engine that
 * understands it.
 */
export const plugin = async (args: PluginInputArgs): Promise<PluginOutputArgs> => {
  args.jobLog(
    'Replace Original File must be run by the trawlarr engine; refusing to run standalone.',
  );
  throw new Error(
    'The Replace Original File node must be run by the trawlarr engine, which performs the ' +
      'file replacement itself. This usually means the engine did not register its executor.',
  );
};
