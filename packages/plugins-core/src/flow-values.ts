import { normalizeLanguageTag } from '@trawlarr/core';
import type { PluginFileObject, ProbeStream } from '@trawlarr/plugin-api';

export interface FlowValueArgs {
  inputFileObj: Pick<
    PluginFileObject,
    '_id' | 'container' | 'file_size' | 'bit_rate' | 'ffProbeData'
  >;
  originalLibraryFile?: Pick<PluginFileObject, '_id'>;
  variables: {
    user: Record<string, string>;
    flowError?: { nodeId: string; pluginId: string; pluginName: string; message: string };
  };
  userVariables: { global: Record<string, string>; library: Record<string, string> };
  job: { jobId: string; fileId: string };
}

export type FlowValue = string | number | boolean | string[];

/**
 * Every property `readFlowValue` can answer, each with the sentence the flow
 * editor shows beside it.
 *
 * Documented here rather than in the UI because this list and `readFlowValue`
 * must not be able to disagree: a property the editor offers but the engine
 * cannot read fails the file at run time, which is the worst place to find
 * out. `FLOW_FIELDS` is derived from it for the same reason.
 */
export const FLOW_FIELD_DOCS: { name: string; description: string }[] = [
  { name: 'file.path', description: 'Absolute path of the file this step is working on.' },
  { name: 'file.name', description: 'File name with extension, without any directories.' },
  { name: 'file.id', description: "The file's id in this daemon's database." },
  { name: 'file.container', description: 'Container as probed, lowercase and without a dot.' },
  {
    name: 'file.sizeMb',
    description: 'Size in decimal megabytes, as the plugin contract reports it.',
  },
  { name: 'file.sizeBytes', description: 'Size in bytes, rounded from the reported megabytes.' },
  { name: 'file.durationSeconds', description: 'Container duration in seconds.' },
  { name: 'file.bitrate', description: 'Overall container bitrate in bits per second.' },
  { name: 'video.codec', description: 'Codec of the first video stream that is not cover art.' },
  { name: 'video.width', description: 'Width of that video stream in pixels.' },
  { name: 'video.height', description: 'Height of that video stream in pixels.' },
  {
    name: 'video.hdr',
    description: 'True for PQ or HLG transfer metadata; missing when the file does not say.',
  },
  { name: 'audio.count', description: 'Number of audio streams.' },
  {
    name: 'audio.languages',
    description: 'Normalized language tags of the audio streams, without duplicates.',
  },
  { name: 'audio.codecs', description: 'Codecs of the audio streams, without duplicates.' },
  {
    name: 'audio.channels',
    description: 'Channel counts of all audio streams as strings (e.g. "2", "6").',
  },
  { name: 'audio.maxChannels', description: 'Highest channel count across the audio streams.' },
  { name: 'subtitle.count', description: 'Number of subtitle streams.' },
  { name: 'subtitle.languages', description: 'Normalized language tags of the subtitle streams.' },
  { name: 'subtitle.codecs', description: 'Codecs of the subtitle streams, without duplicates.' },
  {
    name: 'original.path',
    description: 'Path of the library file this run started from, before any staging copy.',
  },
  { name: 'job.id', description: 'Id of the job running this flow.' },
  { name: 'error.message', description: 'Failure message. Only available on an On Error branch.' },
  { name: 'error.nodeId', description: 'Id of the node that failed. Only on an On Error branch.' },
  {
    name: 'error.pluginId',
    description: 'Plugin id of the node that failed. Only on an On Error branch.',
  },
  {
    name: 'error.pluginName',
    description: 'Name of the plugin that failed. Only on an On Error branch.',
  },
];

/** Variable namespaces that take any name the operator chose, so they cannot be listed. */
export const FLOW_FIELD_NAMESPACES: { prefix: string; description: string }[] = [
  { prefix: 'user.', description: 'A variable set earlier in this run by a node that writes one.' },
  { prefix: 'library.', description: 'A user variable configured on the library being processed.' },
  { prefix: 'global.', description: 'A user variable configured for this daemon.' },
];

export const FLOW_FIELDS = FLOW_FIELD_DOCS.map((field) => field.name);

const finite = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === ''))
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const languages = (streams: ProbeStream[]): string[] => [
  ...new Set(streams.map((stream) => normalizeLanguageTag(stream.tags?.language || 'und'))),
];

const variable = (values: Record<string, string>, name: string): string | undefined =>
  Object.hasOwn(values, name) ? values[name] : undefined;

export const readFlowValue = (args: FlowValueArgs, name: string): FlowValue | undefined => {
  if (name.startsWith('user.')) return variable(args.variables.user, name.slice(5));
  if (name.startsWith('global.')) return variable(args.userVariables.global, name.slice(7));
  if (name.startsWith('library.')) return variable(args.userVariables.library, name.slice(8));
  const file = args.inputFileObj;
  const streams = file.ffProbeData.streams;
  const video = streams?.find((stream) => {
    const disposition = stream.disposition;
    return (
      stream.codec_type === 'video' &&
      !(
        disposition !== null &&
        typeof disposition === 'object' &&
        'attached_pic' in disposition &&
        Number(disposition.attached_pic) === 1
      )
    );
  });
  const audio = streams?.filter((stream) => stream.codec_type === 'audio');
  const subtitles = streams?.filter((stream) => stream.codec_type === 'subtitle');
  switch (name) {
    case 'file.path':
      return file._id;
    case 'file.name':
      return file._id.split(/[\\/]/).at(-1);
    case 'file.id':
      return args.job.fileId;
    case 'file.container':
      return file.container;
    case 'file.sizeMb':
      return finite(file.file_size);
    case 'file.sizeBytes': {
      // The plugin contract reports decimal MB, not bytes or MiB.
      const megabytes = finite(file.file_size);
      const bytes = megabytes === undefined ? undefined : finite(megabytes * 1_000_000);
      return bytes === undefined ? undefined : Math.round(bytes);
    }
    case 'file.durationSeconds':
      return finite(file.ffProbeData.format?.duration);
    case 'file.bitrate':
      return finite(file.ffProbeData.format?.bit_rate);
    case 'video.codec':
      return video?.codec_name;
    case 'video.width':
      return finite(video?.width);
    case 'video.height':
      return finite(video?.height);
    case 'video.hdr': {
      const transfer = video?.color_transfer;
      if (
        typeof transfer !== 'string' ||
        transfer === '' ||
        transfer === 'unknown' ||
        transfer === 'unspecified'
      )
        return undefined;
      return transfer === 'smpte2084' || transfer === 'arib-std-b67';
    }
    case 'audio.count':
      return audio?.length;
    case 'audio.languages':
      return audio && languages(audio);
    case 'audio.codecs':
      return audio && [...new Set(audio.map((stream) => stream.codec_name))];
    case 'audio.channels': {
      // UNDEFINED when ANY stream's channel count is unreadable, matching
      // `audio.maxChannels` below. Filtering the unreadable streams out and
      // answering from the rest looks harmless on a list property, but it
      // turns partial probe data into a confident answer: `audio.channels
      // does not include "6"` would return true for a file whose one
      // unprobed stream is the 5.1 track. A condition that cannot be
      // answered must not be answered.
      if (!audio || audio.some((stream) => finite(stream.channels) === undefined)) return undefined;
      return [...new Set(audio.map((stream) => String(Number(stream.channels))))];
    }
    case 'audio.maxChannels': {
      if (!audio || audio.some((stream) => finite(stream.channels) === undefined)) return undefined;
      return Math.max(0, ...audio.map((stream) => Number(stream.channels)));
    }
    case 'subtitle.count':
      return subtitles?.length;
    case 'subtitle.languages':
      return subtitles && languages(subtitles);
    case 'subtitle.codecs':
      return subtitles && [...new Set(subtitles.map((stream) => stream.codec_name))];
    case 'original.path':
      return args.originalLibraryFile?._id;
    case 'job.id':
      return args.job.jobId;
    case 'error.message':
      return args.variables.flowError?.message;
    case 'error.nodeId':
      return args.variables.flowError?.nodeId;
    case 'error.pluginId':
      return args.variables.flowError?.pluginId;
    case 'error.pluginName':
      return args.variables.flowError?.pluginName;
    default:
      throw new Error(
        `Unknown flow property "${name}". Use a listed property or user.*, library.*, global.*.`,
      );
  }
};

export const renderMessageTemplate = (args: FlowValueArgs, template: string): string => {
  const tokens = /\{\{([\s\S]*?)\}\}/g;
  const literal = template.replace(tokens, '');
  if (literal.includes('{{') || literal.includes('}}')) {
    throw new Error('Message has an unclosed placeholder. Use {{file.path}}, for example.');
  }
  return template.replace(tokens, (_, raw: string) => {
    const name = raw.trim();
    const value = readFlowValue(args, name);
    if (value === undefined)
      throw new Error(`Flow property "${name}" is unavailable at this step.`);
    return Array.isArray(value) ? value.join(', ') : String(value);
  });
};
