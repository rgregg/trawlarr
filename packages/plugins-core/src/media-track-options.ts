import { normalizeLanguageTag } from '@trawlarr/core';
import type {
  FfmpegCommandStream,
  PluginInput,
  PluginInputArgs,
  PluginOutputArgs,
} from '@trawlarr/plugin-api';

export const textInput = (value: unknown, name: string, fallback = ''): string => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  return value.trim();
};

export const switchInput = (value: unknown, name: string): boolean => {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new Error(`${name} must be true or false.`);
};

export const languageKey = (value: string): string =>
  normalizeLanguageTag(value.trim().toLowerCase()).toLowerCase();

const languageInput = (value: string, name: string): string => {
  const normalized = languageKey(value);
  if (!/^[a-z]{2,3}$/.test(normalized)) {
    throw new Error(`${name} must contain language codes such as eng, fra, jpn, or und.`);
  }
  return normalized;
};

export const defaultLanguageInput = (value: unknown): string => {
  const text = textInput(value, 'Default language');
  return text === '' ? '' : languageInput(text, 'Default language');
};

export const streamLanguage = (stream: FfmpegCommandStream): string => {
  let language = stream.tags?.language || 'und';
  for (let i = 0; i < stream.outputArgs.length; i += 2) {
    const value = stream.outputArgs[i + 1] ?? '';
    if (/^-metadata(?::|$)/.test(stream.outputArgs[i]!) && value.startsWith('language=')) {
      language = value.slice('language='.length) || 'und';
    }
  }
  return languageKey(language);
};

export const dispositionFlag = (stream: FfmpegCommandStream, flag: string): boolean => {
  let enabled = Number((stream.disposition as Record<string, unknown> | undefined)?.[flag]) === 1;
  for (let i = 0; i < stream.outputArgs.length; i += 2) {
    if (!/^-disposition(?::|$)/.test(stream.outputArgs[i]!)) continue;
    const value = stream.outputArgs[i + 1] ?? '';
    if (!value.startsWith('+') && !value.startsWith('-')) enabled = false;
    for (const match of value.matchAll(/([+-]?)([a-z_]+)/g)) {
      if (match[2] === flag) enabled = match[1] !== '-';
    }
  }
  return enabled;
};

export const configuredCodec = (stream: FfmpegCommandStream): string | undefined => {
  let codec: string | undefined;
  for (let i = 0; i < stream.outputArgs.length; i += 2) {
    if (/^-(?:c|codec|vcodec|acodec|scodec)(?::|$)/.test(stream.outputArgs[i]!)) {
      codec = stream.outputArgs[i + 1];
    }
  }
  return codec;
};

export const stereoAac = (stream: FfmpegCommandStream): boolean => {
  const configured = configuredCodec(stream);
  const codec = configured === undefined || configured === 'copy' ? stream.codec_name : configured;
  let channels = Number(stream.channels);
  for (let i = 0; i < stream.outputArgs.length; i += 2) {
    if (/^-ac(?::|$)/.test(stream.outputArgs[i]!)) channels = Number(stream.outputArgs[i + 1]);
  }
  return (codec === 'aac' || codec === 'libfdk_aac') && channels === 2;
};

export const isCommentary = (stream: FfmpegCommandStream): boolean =>
  dispositionFlag(stream, 'comment') || /\bcommentary\b/i.test(stream.tags?.title ?? '');

export const languageFilter = (
  inputs: Record<string, unknown>,
): ((stream: FfmpegCommandStream) => boolean) => {
  const mode = textInput(inputs.languageMode, 'Language mode', 'keep');
  if (mode !== 'keep' && mode !== 'remove') {
    throw new Error('Language mode must be keep or remove.');
  }
  const text = textInput(inputs.languages, 'Languages');
  if (text === '') return () => true;
  const languages = new Set(text.split(',').map((value) => languageInput(value, 'Languages')));
  return (stream) => languages.has(streamLanguage(stream)) === (mode === 'keep');
};

export const preferredTrack = (
  streams: readonly FfmpegCommandStream[],
): FfmpegCommandStream | undefined =>
  streams.find((stream) => dispositionFlag(stream, 'default') && !isCommentary(stream)) ??
  streams.find((stream) => !isCommentary(stream)) ??
  streams.find((stream) => dispositionFlag(stream, 'default')) ??
  streams[0];

export const chooseDefault = (
  streams: readonly FfmpegCommandStream[],
  language: string,
  args: PluginInputArgs,
): void => {
  if (language === '') return;
  const chosen = preferredTrack(streams.filter((stream) => streamLanguage(stream) === language));
  if (chosen === undefined) {
    args.jobLog(`No retained ${language} track is available; default dispositions are unchanged.`);
    return;
  }
  for (const stream of streams) {
    const wanted = stream === chosen;
    if (dispositionFlag(stream, 'default') === wanted) continue;
    // +/- changes only the default bit, retaining forced, commentary, SDH, etc.
    stream.outputArgs.push('-disposition:{outputIndex}', wanted ? '+default' : '-default');
    stream.disposition = {
      ...(stream.disposition as Record<string, unknown> | undefined),
      default: wanted ? 1 : 0,
    };
  }
};

export const passThrough = (args: PluginInputArgs): PluginOutputArgs => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});

export const showWhen = (
  name: string,
  value: string,
): PluginInput['inputUI']['displayConditions'] => ({
  logic: 'AND',
  sets: [{ logic: 'AND', inputs: [{ name, value, condition: '===' }] }],
});

export const languageInputs = (): PluginInput[] => [
  {
    name: 'languageMode',
    label: 'Language selection',
    type: 'string',
    defaultValue: 'keep',
    tooltip:
      'Keep only listed languages, or remove listed languages. Empty lists preserve all tracks.',
    inputUI: { type: 'dropdown', options: ['keep', 'remove'] },
  },
  {
    name: 'languages',
    label: 'Languages',
    type: 'string',
    defaultValue: '',
    tooltip:
      'Comma-separated language codes, e.g. eng,jpn. Common aliases are normalized. ' +
      'Use und for untagged tracks. Empty preserves every language, including commentary.',
    inputUI: { type: 'text' },
  },
  {
    name: 'defaultLanguage',
    label: 'Default language',
    type: 'string',
    defaultValue: '',
    tooltip:
      'If present, make one retained track in this language default, preferring a current ' +
      'non-commentary default. Other disposition flags are preserved. Empty leaves defaults unchanged.',
    inputUI: { type: 'text' },
  },
];
