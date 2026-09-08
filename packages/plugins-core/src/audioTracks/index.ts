import { assertCommandInitialised, isUnmappableStream } from '@trawlarr/core';
import type {
  FfmpegCommandStream,
  PluginDetails,
  PluginInputArgs,
  PluginOutputArgs,
} from '@trawlarr/plugin-api';
import {
  chooseDefault,
  cleanAudioFilter,
  defaultLanguageInput,
  isCommentary,
  languageFilter,
  languageInputs,
  passThrough,
  preferredTrack,
  showWhen,
  stereoAac,
  stereoActionInput,
  streamLanguage,
  switchInput,
} from '../media-track-options.js';

export const details = (): PluginDetails => ({
  name: 'Audio Tracks',
  description:
    'Select audio languages and defaults; optionally add or convert to one stereo AAC track.',
  style: { borderColor: '#5588bb' },
  tags: 'ffmpeg,audio,language',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 4,
  icon: 'faVolumeUp',
  inputs: [
    ...languageInputs(),
    {
      name: 'ensureStereo',
      label: 'Ensure stereo AAC',
      type: 'boolean',
      defaultValue: 'false',
      tooltip:
        'Add or convert to a stereo AAC track for the preferred retained audio track only if that ' +
        'language and commentary role have no stereo AAC track. ' +
        'Select the default language above to prefer it; otherwise use the current main/default track.',
      inputUI: { type: 'switch' },
    },
    {
      name: 'stereoAction',
      label: 'Stereo action',
      type: 'string',
      defaultValue: 'add',
      tooltip:
        'Whether to add a new stereo AAC track alongside existing audio ("add"), or convert ' +
        'the source track in-place to stereo AAC ("convert"). Tracks already in stereo AAC are ' +
        'kept as-is.',
      inputUI: {
        type: 'dropdown',
        options: ['add', 'convert'],
        displayConditions: showWhen('ensureStereo', 'true'),
      },
    },
    {
      name: 'stereoBitrate',
      label: 'Stereo bitrate (kbps)',
      type: 'number',
      defaultValue: '192',
      tooltip:
        '32–512 kbps for newly added or converted stereo AAC tracks. Existing stereo AAC is kept ' +
        'without re-encoding, regardless of its bitrate. AAC requires a compatible final container, ' +
        'such as mkv, mp4, or mov.',
      inputUI: { type: 'text', displayConditions: showWhen('ensureStereo', 'true') },
    },
    {
      name: 'downmixFilter',
      label: 'Downmix pan filter',
      type: 'string',
      defaultValue: '',
      tooltip:
        'Optional ffmpeg audio filter applied when downmixing multichannel audio to stereo, e.g. ' +
        '"pan=stereo|c0=c2+0.30*c0+0.30*c4|c1=c2+0.30*c1+0.30*c5" for dialogue boost. ' +
        'If empty, standard ffmpeg stereo downmix (-ac 2) is used. Only applies when downmixing ' +
        'from more than 2 channels.',
      inputUI: { type: 'text', displayConditions: showWhen('ensureStereo', 'true') },
    },
  ],
  outputs: [{ number: 1, tooltip: 'Audio track selection applied' }],
  requiresVersion: '1.0.0',
});

const bitrateInput = (value: unknown): number => {
  if (value === undefined) return 192;
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !/^\d+$/.test(String(value).trim())
  ) {
    throw new Error('Stereo bitrate must be an integer from 32 to 512 kbps.');
  }
  const bitrate = Number(value);
  if (!Number.isInteger(bitrate) || bitrate < 32 || bitrate > 512) {
    throw new Error('Stereo bitrate must be an integer from 32 to 512 kbps.');
  }
  return bitrate;
};

const addStereo = (
  args: PluginInputArgs,
  source: FfmpegCommandStream,
  bitrate: number,
  downmixFilter?: string,
): FfmpegCommandStream => {
  const command = args.variables.ffmpegCommand;
  const title = isCommentary(source) ? 'Stereo compatibility (commentary)' : 'Stereo compatibility';
  const shouldFilter = Boolean(downmixFilter && Number(source.channels) > 2);
  const clone: FfmpegCommandStream = {
    ...source,
    codec_name: 'aac',
    channels: 2,
    bit_rate: bitrate * 1000,
    channel_layout: 'stereo',
    tags: { ...source.tags, title },
    disposition: {
      ...(source.disposition as Record<string, unknown> | undefined),
      default: 0,
    },
    removed: false,
    forceEncoding: true,
    inputArgs: [...source.inputArgs],
    // A duplicate must retain the source map, not the appended array position.
    mapArgs:
      source.mapArgs.length > 0
        ? [...source.mapArgs]
        : ['-map', `0:${String(source.index ?? command.streams.indexOf(source))}`],
    outputArgs: [
      // A previous node may have changed language/dispositions only in argv.
      // Carry those labels, never its encoder or filters, onto the new copy.
      ...source.outputArgs.flatMap((flag, index, all) =>
        index % 2 === 0 && /^-(?:metadata|disposition)(?::|$)/.test(flag)
          ? [flag, all[index + 1]!]
          : [],
      ),
      '-c:{outputIndex}',
      'aac',
      '-ac:{outputIndex}',
      '2',
      ...(shouldFilter ? ['-filter:{outputIndex}', downmixFilter!.trim()] : []),
      '-b:{outputIndex}',
      `${String(bitrate)}k`,
      '-metadata:s:{outputIndex}',
      `title=${title}`,
      '-disposition:{outputIndex}',
      '-default',
    ],
  };
  command.streams.push(clone);
  args.jobLog(
    `Adding ${String(bitrate)} kbps stereo AAC for ${streamLanguage(source)} audio` +
      (shouldFilter ? ` with downmix filter "${downmixFilter!.trim()}".` : '.'),
  );
  return clone;
};

const convertStereo = (
  args: PluginInputArgs,
  source: FfmpegCommandStream,
  bitrate: number,
  downmixFilter?: string,
): void => {
  const wasMultichannel = Number(source.channels) > 2;
  const shouldFilter = Boolean(downmixFilter && wasMultichannel);
  source.codec_name = 'aac';
  source.channels = 2;
  source.bit_rate = bitrate * 1000;
  source.channel_layout = 'stereo';
  source.forceEncoding = true;
  const preserved = source.outputArgs.flatMap((flag, index, all) =>
    index % 2 === 0 && /^-(?:metadata|disposition)(?::|$)/.test(flag)
      ? [flag, all[index + 1]!]
      : [],
  );
  source.outputArgs = [
    ...preserved,
    '-c:{outputIndex}',
    'aac',
    '-ac:{outputIndex}',
    '2',
    ...(shouldFilter ? ['-filter:{outputIndex}', downmixFilter!.trim()] : []),
    '-b:{outputIndex}',
    `${String(bitrate)}k`,
  ];
  args.jobLog(
    `Converting ${streamLanguage(source)} audio to ${String(bitrate)} kbps stereo AAC` +
      (shouldFilter ? ` with downmix filter "${downmixFilter!.trim()}".` : '.'),
  );
};

export const plugin = async (args: PluginInputArgs): Promise<PluginOutputArgs> => {
  const command = args.variables.ffmpegCommand;
  assertCommandInitialised(command);
  const keep = languageFilter(args.inputs);
  const defaultLanguage = defaultLanguageInput(args.inputs.defaultLanguage);
  const ensureStereo = switchInput(args.inputs.ensureStereo, 'Ensure stereo AAC');
  const stereoAction = ensureStereo ? stereoActionInput(args.inputs.stereoAction) : 'add';
  const bitrate = ensureStereo ? bitrateInput(args.inputs.stereoBitrate) : 192;
  const downmixFilter = ensureStereo ? cleanAudioFilter(args.inputs.downmixFilter) : '';
  const active = command.streams.filter(
    (stream) => stream.codec_type === 'audio' && !stream.removed,
  );
  const retained = active.filter(keep);
  if (
    active.some((stream) => !isUnmappableStream(stream)) &&
    !retained.some((stream) => !isUnmappableStream(stream))
  ) {
    throw new Error(
      'Audio Tracks would remove every usable audio track. Change the language list or leave it ' +
        'empty to preserve audio; no audio tracks were removed.',
    );
  }
  for (const stream of active) {
    if (!retained.includes(stream)) stream.removed = true;
  }
  chooseDefault(retained, defaultLanguage, args);
  if (ensureStereo) {
    const usable = retained.filter((stream) => !isUnmappableStream(stream));
    const matching = usable.filter((stream) => streamLanguage(stream) === defaultLanguage);
    const source = preferredTrack(matching.length > 0 ? matching : usable);
    if (
      source !== undefined &&
      !usable.some(
        (stream) =>
          stereoAac(stream) &&
          streamLanguage(stream) === streamLanguage(source) &&
          isCommentary(stream) === isCommentary(source),
      )
    ) {
      if (stereoAction === 'convert') {
        convertStereo(args, source, bitrate, downmixFilter);
      } else {
        addStereo(args, source, bitrate, downmixFilter);
      }
    }
  }
  return passThrough(args);
};
