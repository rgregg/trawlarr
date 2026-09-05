import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';

export const details = (): PluginDetails => ({
  name: 'On Error',
  description:
    'Enter a recovery branch when a plugin fails. Preserve the failed outcome unless successful recovery is explicitly enabled.',
  style: { borderColor: '#a8433a' },
  tags: 'error,recovery',
  isStartPlugin: false,
  pType: 'onFlowError',
  sidebarPosition: 9,
  icon: 'faTriangleExclamation',
  inputs: [
    {
      name: 'recoverAsSuccess',
      label: 'Allow successful recovery',
      type: 'boolean',
      defaultValue: 'false',
      tooltip:
        'Off by default: logging an error does not make a file converged. Enable only when this branch repairs the failure and finishing it should count as success. The original error remains available.',
      inputUI: { type: 'switch' },
    },
  ],
  outputs: [{ number: 1, tooltip: 'Continue' }],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): PluginOutputArgs => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: {
    ...args.variables,
    flowErrorOutcome:
      args.inputs.recoverAsSuccess === true || args.inputs.recoverAsSuccess === 'true'
        ? 'success'
        : 'failure',
  },
});
