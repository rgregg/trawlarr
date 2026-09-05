import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { renderMessageTemplate } from '../flow-values.js';

const DEFAULT_MESSAGE = 'Reached this point in the flow.';

export const details = (): PluginDetails => ({
  name: 'Write to Log',
  description:
    'Write a plain or templated message to the job log, then continue without changing the file.',
  style: { borderColor: '#1a6699' },
  tags: 'utility,log,debug',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 7,
  icon: 'faFileLines',
  inputs: [
    {
      label: 'Log message',
      name: 'message',
      type: 'string',
      defaultValue: DEFAULT_MESSAGE,
      tooltip:
        'Text for the job log and step excerpt. Enable placeholders to use {{file.path}}, {{video.codec}}, {{audio.languages}}, {{job.id}}, {{error.message}}, or {{user.name}}. Error fields require an On Error branch; missing or unknown properties are reported as errors.',
      inputUI: { type: 'textarea' },
    },
    {
      label: 'Expand placeholders',
      name: 'interpolate',
      type: 'boolean',
      defaultValue: 'false',
      tooltip:
        'Opt in to {{property}} substitution. Off preserves literal text and existing flows. No JavaScript is evaluated.',
      inputUI: { type: 'switch' },
    },
  ],
  outputs: [{ number: 1, tooltip: 'Continue after logging' }],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): PluginOutputArgs => {
  const interpolate = args.inputs.interpolate ?? false;
  if (
    interpolate !== true &&
    interpolate !== false &&
    interpolate !== 'true' &&
    interpolate !== 'false'
  ) {
    throw new Error('Expand placeholders must be true or false.');
  }
  const message = String(args.inputs.message ?? DEFAULT_MESSAGE);
  args.jobLog(
    interpolate === true || interpolate === 'true' ? renderMessageTemplate(args, message) : message,
  );
  return {
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};
