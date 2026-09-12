import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { normalizeLanguageTag } from '@trawlarr/core';

/**
 * "Does ONE audio stream match all of these at once?"
 *
 * The flat `audio.*` properties a Check Condition reads cannot answer that.
 * They project every stream into one list each, so `audio.codecs contains
 * aac` AND `audio.channels contains 2` is satisfied by a file holding a 5.1
 * AAC track beside a stereo AC3 one — two streams, neither of them a stereo
 * AAC, and the condition passes. Upstream has the same hole: Tdarr's Check
 * Audio Codec matches per stream, but Check Channel Count scans every stream
 * independently, so chaining the two produces the identical false positive.
 *
 * Every criterion left blank is simply not tested, so this is also a plain
 * "is there an AAC track at all" or "is there a 2-channel track at all".
 */
export const details = (): PluginDetails => ({
  name: 'Check Audio Stream',
  description:
    'Branch on whether a SINGLE audio stream matches every criterion given — for example a ' +
    '2-channel AAC track, rather than an AAC track and a 2-channel track.',
  style: { borderColor: '#3399cc' },
  tags: 'audio,filter',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [
    {
      label: 'Codec',
      name: 'codec',
      type: 'string',
      defaultValue: '',
      tooltip:
        'Codec the stream must use, as ffprobe names it. Leave blank to accept any codec. ' +
        'Choosing aac also accepts libfdk_aac, which is the same codec by another encoder.',
      inputUI: {
        type: 'dropdown',
        options: ['', 'aac', 'ac3', 'eac3', 'dts', 'truehd', 'flac', 'opus', 'mp3', 'vorbis'],
      },
    },
    {
      label: 'Channels',
      name: 'channels',
      type: 'number',
      defaultValue: '',
      tooltip:
        'Exact channel count the stream must have — 2 for stereo, 6 for 5.1. Leave blank to ' +
        'accept any channel count.',
      inputUI: { type: 'text' },
    },
    {
      label: 'Language',
      name: 'language',
      type: 'string',
      defaultValue: '',
      tooltip:
        'Language tag the stream must carry, normalized the same way the audio.languages ' +
        'property is. Leave blank to accept any language.',
      inputUI: { type: 'text' },
    },
  ],
  outputs: [
    { number: 1, tooltip: 'A single stream matches every criterion' },
    { number: 2, tooltip: 'No one stream matches them all' },
  ],
  requiresVersion: '1.0.0',
});

/** aac and libfdk_aac are the same codec through different encoders. */
const codecMatches = (actual: string, wanted: string): boolean =>
  actual === wanted || (wanted === 'aac' && actual === 'libfdk_aac');

export const plugin = (args: PluginInputArgs): PluginOutputArgs => {
  const wantedCodec = String(args.inputs.codec ?? '')
    .trim()
    .toLowerCase();
  const rawChannels = String(args.inputs.channels ?? '').trim();
  const wantedLanguage = String(args.inputs.language ?? '').trim();

  if (rawChannels !== '' && !Number.isFinite(Number(rawChannels))) {
    throw new Error(`Channels must be a number, got "${rawChannels}".`);
  }
  const wantedChannels = rawChannels === '' ? undefined : Number(rawChannels);

  if (wantedCodec === '' && wantedChannels === undefined && wantedLanguage === '') {
    // Every criterion blank asks "is there an audio stream", which the
    // `audio.count` property already answers. Refusing is kinder than
    // silently passing every file with sound: a node configured by accident
    // would otherwise look like a working check.
    throw new Error('Give at least one of codec, channels or language to test for.');
  }

  const streams = args.inputFileObj.ffProbeData?.streams;
  if (!Array.isArray(streams)) {
    // Unprobed is NOT "no match": answering 2 here would send a file down
    // the "needs converting" branch on the strength of data nobody read.
    throw new Error('This file has no probe data, so its audio streams cannot be checked.');
  }

  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const match = audio.find((stream) => {
    const codec = String(stream.codec_name ?? '').toLowerCase();
    if (wantedCodec !== '' && !codecMatches(codec, wantedCodec)) return false;
    if (wantedChannels !== undefined) {
      // An unreadable channel count cannot be SHOWN to match, so it does not.
      // The cost of being wrong here is a redundant transcode; the cost of
      // treating unknown as a match is a file that silently never converges.
      if (!Number.isFinite(Number(stream.channels))) return false;
      if (Number(stream.channels) !== wantedChannels) return false;
    }
    if (
      wantedLanguage !== '' &&
      normalizeLanguageTag(stream.tags?.language || 'und') !== normalizeLanguageTag(wantedLanguage)
    ) {
      return false;
    }
    return true;
  });

  const wanted = [
    wantedCodec === '' ? null : `codec ${wantedCodec}`,
    wantedChannels === undefined ? null : `${String(wantedChannels)} channels`,
    wantedLanguage === '' ? null : `language ${wantedLanguage}`,
  ]
    .filter((part) => part !== null)
    .join(', ');

  args.jobLog(
    match === undefined
      ? `No single audio stream has ${wanted} (${String(audio.length)} audio stream(s) checked).`
      : `Audio stream ${String(match.index ?? 0)} has ${wanted}.`,
  );

  return {
    outputNumber: match === undefined ? 2 : 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};
