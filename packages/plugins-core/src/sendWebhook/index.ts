import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { renderMessageTemplate } from '../flow-values.js';

export const details = (): PluginDetails => ({
  name: 'Send Webhook',
  description: 'Send an alert to a named destination, then continue. Never fails the flow.',
  style: { borderColor: '#1a6699' },
  tags: 'utility,alert,webhook,notify',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 11,
  icon: 'faBell',
  inputs: [
    {
      label: 'Destination',
      name: 'destination',
      type: 'string',
      defaultValue: '',
      tooltip: 'Name of an alert destination from Settings. The URL and secrets stay there.',
      inputUI: { type: 'text' },
    },
    {
      label: 'Message',
      name: 'message',
      type: 'string',
      defaultValue: '',
      tooltip:
        'Place this before Hold for Review: Hold is terminal, so a node after it never runs. ' +
        'Supports {{file.path}} and the other placeholders; blank sends the file name.',
      inputUI: { type: 'textarea', acceptsFlowFields: true },
    },
  ],
  outputs: [{ number: 1, tooltip: 'Continue after sending' }],
  requiresVersion: '1.0.0',
});

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * An alert is a courtesy, never a gate: every failure here is logged and the flow continues.
 * A thrown error from a notification would otherwise fail (and retry, and eventually park) a
 * file whose transcode was perfectly fine. The node holds no URL or header; the daemon resolves
 * the destination name, so nothing secret can reach a job log from here.
 */
export const plugin = (args: PluginInputArgs): PluginOutputArgs => {
  const done = (): PluginOutputArgs => ({
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  });
  const destination = typeof args.inputs.destination === 'string' ? args.inputs.destination : '';
  if (destination.trim() === '') {
    args.jobLog('Send Webhook: no destination set; skipped');
    return done();
  }
  if (args.sendAlert === undefined) {
    args.jobLog('alerts unavailable here; skipped');
    return done();
  }
  const raw = typeof args.inputs.message === 'string' ? args.inputs.message : '';
  // A blank message sends the file name rather than skipping: the operator asked for an alert.
  let message = raw.trim() === '' ? baseName(args.inputFileObj._id) : raw;
  try {
    message = renderMessageTemplate(args, message);
  } catch (error) {
    // A bad placeholder must not swallow the alert; send the text as written.
    args.jobLog(
      `Send Webhook: ${error instanceof Error ? error.message : 'placeholder error'}; sending the message as written`,
    );
  }
  try {
    args.sendAlert(destination.trim(), message);
  } catch {
    args.jobLog('Send Webhook: the alert could not be sent; continuing');
  }
  return done();
};
