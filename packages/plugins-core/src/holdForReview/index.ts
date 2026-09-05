import { ReviewHoldSignal } from '@trawlarr/core';
import type { PluginDetails, PluginInputArgs } from '@trawlarr/plugin-api';

const DEFAULT_REASON = 'Review requested by the flow.';

export const details = (): PluginDetails => ({
  name: 'Hold for Review',
  description: 'Stop processing until an operator reviews and explicitly requeues the file.',
  style: { borderColor: '#b8860b' },
  tags: 'review,hold,terminal',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 10,
  icon: 'faPause',
  inputs: [
    {
      label: 'Review reason',
      name: 'reason',
      type: 'string',
      defaultValue: DEFAULT_REASON,
      tooltip:
        'Explain what an operator should review. No automatic retries or retry attempts are spent.',
      inputUI: { type: 'textarea' },
    },
  ],
  outputs: [],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): never => {
  const reason = String(args.inputs.reason ?? '').trim() || DEFAULT_REASON;
  args.jobLog(`Held for review: ${reason}`);
  throw new ReviewHoldSignal(reason);
};
