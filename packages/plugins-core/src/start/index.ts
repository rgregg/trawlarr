import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';

export const details = (): PluginDetails => ({
  name: 'Start',
  description: 'Entry point for the flow. Every file enters here.',
  style: { borderColor: '#33aa33' },
  tags: 'start',
  isStartPlugin: true,
  pType: 'start',
  sidebarPosition: -1,
  icon: 'faPlay',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'Continue' }],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): PluginOutputArgs => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});
