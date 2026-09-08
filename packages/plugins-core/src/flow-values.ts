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

export const FLOW_FIELDS = [
  'file.path',
  'file.name',
  'file.id',
  'file.container',
  'file.sizeMb',
  'file.sizeBytes',
  'file.durationSeconds',
  'file.bitrate',
  'video.codec',
  'video.width',
  'video.height',
  'video.hdr',
  'audio.count',
  'audio.languages',
  'audio.codecs',
  'audio.maxChannels',
  'subtitle.count',
  'subtitle.languages',
  'subtitle.codecs',
  'original.path',
  'job.id',
  'error.message',
  'error.nodeId',
  'error.pluginId',
  'error.pluginName',
];

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
