import { assertCommandInitialised } from '@trawlarr/core';
import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import {
  chooseDefault,
  defaultLanguageInput,
  dispositionFlag,
  languageFilter,
  languageInputs,
  passThrough,
  showWhen,
  switchInput,
} from '../media-track-options.js';

export const details = (): PluginDetails => ({
  name: 'Subtitle Tracks',
  description:
    'Preserve subtitles by default, or select languages, forced tracks, and a default language.',
  style: { borderColor: '#5588bb' },
  tags: 'ffmpeg,subtitle,language',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 4,
  icon: 'faClosedCaptioning',
  inputs: [
    {
      name: 'removeAll',
      label: 'Remove all subtitles',
      type: 'boolean',
      defaultValue: 'false',
      tooltip:
        'Explicitly remove every subtitle track. Never removes audio, video, data, or attachments.',
      inputUI: { type: 'switch' },
    },
    ...languageInputs().map((input) => ({
      ...input,
      inputUI: { ...input.inputUI, displayConditions: showWhen('removeAll', 'false') },
    })),
    {
      name: 'forcedOnly',
      label: 'Keep forced subtitles only',
      type: 'boolean',
      defaultValue: 'false',
      tooltip:
        'Among the selected languages, keep only tracks with the ffprobe forced disposition. ' +
        'May remove all subtitles if none are forced. Titles are not used to guess forced status.',
      inputUI: { type: 'switch', displayConditions: showWhen('removeAll', 'false') },
    },
  ],
  outputs: [{ number: 1, tooltip: 'Subtitle track selection applied' }],
  requiresVersion: '1.0.0',
});

export const plugin = async (args: PluginInputArgs): Promise<PluginOutputArgs> => {
  const command = args.variables.ffmpegCommand;
  assertCommandInitialised(command);
  const removeAll = switchInput(args.inputs.removeAll, 'Remove all subtitles');
  const keep = removeAll ? () => false : languageFilter(args.inputs);
  const forcedOnly = removeAll
    ? false
    : switchInput(args.inputs.forcedOnly, 'Forced subtitles only');
  const defaultLanguage = removeAll ? '' : defaultLanguageInput(args.inputs.defaultLanguage);
  const retained = command.streams.filter((stream) => {
    if (stream.codec_type !== 'subtitle' || stream.removed) return false;
    if (!keep(stream) || (forcedOnly && !dispositionFlag(stream, 'forced'))) {
      stream.removed = true;
      return false;
    }
    return true;
  });
  chooseDefault(retained, defaultLanguage, args);
  return passThrough(args);
};
