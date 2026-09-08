import type { PluginDetails, PluginInputArgs } from '@trawlarr/plugin-api';

const DEFAULT_MESSAGE = 'File rejected by this flow.';

export const details = (): PluginDetails => ({
  name: 'Fail File',
  description:
    'Raise a file-processing error with a custom message. Normal error-handler and retry policy applies.',
  style: { borderColor: '#a8433a' },
  tags: 'error,failure,terminal',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 8,
  icon: 'faCircleXmark',
  inputs: [
    {
      label: 'Failure message',
      name: 'message',
      type: 'string',
      defaultValue: DEFAULT_MESSAGE,
      tooltip:
        'The reason recorded in the job log and failed step. This node has no outgoing connections. ' +
        'Without an onFlowError handler, the attempt fails and normal retries apply; it does not delete the file.',
      inputUI: { type: 'textarea' },
    },
  ],
  outputs: [],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): never => {
  const message = String(args.inputs.message ?? '').trim() || DEFAULT_MESSAGE;
  args.jobLog(message);
  throw new Error(message);
};
