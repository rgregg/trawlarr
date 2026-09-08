import { assertCommandInitialised, isUnmappableStream } from '@trawlarr/core';
import type {
  FfmpegCommandStream,
  PluginDetails,
  PluginInputArgs,
  PluginOutputArgs,
} from '@trawlarr/plugin-api';
import {
  chooseDefault,
  defaultLanguageInput,
  isCommentary,
  languageFilter,
  languageInputs,
  passThrough,
  preferredTrack,
  showWhen,
  stereoAac,
  streamLanguage,
  switchInput,
} from '../media-track-options.js';

export const details = (): PluginDetails => ({
  name: 'Audio Tracks',
  description:
    'Select audio languages and defaults; optionally add one stereo AAC compatibility track.',
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
        'Add a stereo AAC copy of the preferred retained audio track only if that language ' +
        'and commentary role have no stereo AAC track. Keeps every retained original track. ' +
        'Select the default language above to prefer it; otherwise use the current main/default track.',
      inputUI: { type: 'switch' },
    },
    {
      name: 'stereoBitrate',
      label: 'Stereo bitrate (kbps)',
      type: 'number',
      defaultValue: '192',
      tooltip:
        '32–512 kbps for newly added stereo AAC tracks. Existing stereo AAC is kept without re-encoding, ' +
        'regardless of its bitrate. AAC requires a compatible final container, such as mkv, mp4, or mov.',
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
): FfmpegCommandStream => {
  const command = args.variables.ffmpegCommand;
  const title = isCommentary(source) ? 'Stereo compatibility (commentary)' : 'Stereo compatibility';
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
      '-b:{outputIndex}',
      `${String(bitrate)}k`,
      '-metadata:s:{outputIndex}',
      `title=${title}`,
      '-disposition:{outputIndex}',
      '-default',
    ],
  };
  command.streams.push(clone);
  args.jobLog(`Adding ${String(bitrate)} kbps stereo AAC for ${streamLanguage(source)} audio.`);
  return clone;
};

export const plugin = async (args: PluginInputArgs): Promise<PluginOutputArgs> => {
  const command = args.variables.ffmpegCommand;
  assertCommandInitialised(command);
  const keep = languageFilter(args.inputs);
  const defaultLanguage = defaultLanguageInput(args.inputs.defaultLanguage);
  const ensureStereo = switchInput(args.inputs.ensureStereo, 'Ensure stereo AAC');
  const bitrate = ensureStereo ? bitrateInput(args.inputs.stereoBitrate) : 192;
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
      addStereo(args, source, bitrate);
    }
  }
  return passThrough(args);
};
