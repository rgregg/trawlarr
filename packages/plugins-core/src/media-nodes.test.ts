import { describe, expect, it, vi } from 'vitest';
import {
  beginFfmpegCommand,
  compileFfmpegArgs,
  describeCommandChanges,
  emptyFfmpegCommand,
} from '@trawlarr/core';
import type { PluginInputArgs, ProbeStream } from '@trawlarr/plugin-api';
import * as audio from './audioTracks/index.js';
import * as subtitles from './subtitleTracks/index.js';
import * as container from './setContainer/index.js';

const video = { index: 0, codec_type: 'video', codec_name: 'h264' };
const track = (
  index: number,
  type: 'audio' | 'subtitle',
  language = 'eng',
  extra: Partial<ProbeStream> = {},
): ProbeStream => ({
  index,
  codec_type: type,
  codec_name: type === 'audio' ? 'ac3' : 'subrip',
  tags: { language },
  channels: type === 'audio' ? 6 : undefined,
  ...extra,
});
const argsFor = (
  streams: ProbeStream[] = [video, track(1, 'audio')],
  inputs: Record<string, unknown> = {},
  format = 'mkv',
): PluginInputArgs => {
  const file = { _id: `/movie.${format}`, container: format, ffProbeData: { streams } };
  return {
    inputFileObj: file,
    originalLibraryFile: file,
    inputs,
    variables: {
      ffmpegCommand: beginFfmpegCommand({
        probe: file.ffProbeData,
        container: format,
        inputPath: file._id,
      }),
      flowFailed: false,
      user: {},
    },
    jobLog: vi.fn(),
  } as unknown as PluginInputArgs;
};
const changes = (args: PluginInputArgs) =>
  describeCommandChanges({
    command: args.variables.ffmpegCommand,
    source: {
      path: args.inputFileObj._id,
      container: args.inputFileObj.container,
      streams: args.inputFileObj.ffProbeData.streams,
    },
  });
const argv = (args: PluginInputArgs) =>
  compileFfmpegArgs({ command: args.variables.ffmpegCommand, outputPath: '/output.mkv' });
const kept = (args: PluginInputArgs, type: string) =>
  args.variables.ffmpegCommand.streams.filter(
    (stream) => stream.codec_type === type && !stream.removed,
  );

describe.each([
  ['Audio Tracks', audio],
  ['Subtitle Tracks', subtitles],
  ['Set Container', container],
] as const)('%s contract', (name, node) => {
  it('requires Begin Command', async () => {
    const args = argsFor();
    args.variables.ffmpegCommand = emptyFfmpegCommand();
    await expect(node.plugin(args)).rejects.toThrow('Begin Command');
  });

  it('preserves everything by default, including path, variables, and probe objects', async () => {
    const args = argsFor([
      video,
      track(2, 'audio', 'jpn', { tags: { title: 'Commentary', language: 'jpn' } }),
      track(4, 'subtitle'),
      { index: 6, codec_type: 'data', codec_name: 'bin_data' },
      { index: 7, codec_type: 'attachment', codec_name: 'ttf' },
    ]);
    const before = structuredClone(args.variables.ffmpegCommand);
    const result = await node.plugin(args);
    expect(result.outputFileObj._id).toBe(args.inputFileObj._id);
    expect(result.variables).toBe(args.variables);
    expect(result.outputNumber).toBe(1);
    expect(args.variables.ffmpegCommand).toEqual(before);
    expect(changes(args)).toEqual([]);
    expect(node.details().name).toBe(name);
    expect(node.details().outputs).toHaveLength(1);
  });
});

describe('Audio Tracks', () => {
  it.each(['keep', 'remove'])('an empty %s list does not request work', async (languageMode) => {
    const args = argsFor(undefined, { languageMode, languages: '  ' });
    await audio.plugin(args);
    expect(changes(args)).toEqual([]);
    expect(args.variables.ffmpegCommand.shouldProcess).toBe(false);
  });

  it('keeps specified languages with aliases and retains commentary in those languages', async () => {
    const args = argsFor(
      [
        video,
        track(2, 'audio', 'English'),
        track(4, 'audio', 'deu'),
        track(5, 'audio', 'eng', { tags: { language: 'eng', title: 'Commentary' } }),
        track(8, 'audio', 'jpn'),
        track(10, 'subtitle', 'jpn'),
      ],
      { languages: ' en,ger,eng ' },
    );
    await audio.plugin(args);
    expect(kept(args, 'audio').map((stream) => stream.index)).toEqual([2, 4, 5]);
    expect(kept(args, 'subtitle')).toHaveLength(1);
    expect(argv(args)).not.toContain('0:8');
    expect(argv(args)).toContain('0:10');
  });

  it('removes only the listed audio languages, including und for untagged tracks', async () => {
    const args = argsFor(
      [
        video,
        track(1, 'audio'),
        track(3, 'audio', 'jpn'),
        track(4, 'audio', '', { tags: undefined }),
        track(5, 'subtitle', 'jpn'),
      ],
      { languageMode: 'remove', languages: 'jpn,und' },
    );
    await audio.plugin(args);
    expect(kept(args, 'audio').map((stream) => stream.index)).toEqual([1]);
    expect(kept(args, 'subtitle')).toHaveLength(1);
  });

  it('refuses to remove every usable audio track before mutating the command', async () => {
    const args = argsFor(
      [video, track(1, 'audio', 'jpn'), track(2, 'audio', 'eng', { codec_name: 'unknown' })],
      { languages: 'eng' },
    );
    const before = structuredClone(args.variables.ffmpegCommand);
    await expect(audio.plugin(args)).rejects.toThrow('every usable audio');
    expect(args.variables.ffmpegCommand).toEqual(before);
  });

  it('never revives already removed audio or counts it as a surviving track', async () => {
    const args = argsFor([video, track(3, 'audio', 'eng'), track(7, 'audio', 'jpn')], {
      languages: 'eng',
      ensureStereo: true,
    });
    args.variables.ffmpegCommand.streams[1]!.removed = true;
    await expect(audio.plugin(args)).rejects.toThrow('every usable audio');
    expect(args.variables.ffmpegCommand.streams[1]!.removed).toBe(true);
  });

  it('does not add audio to a video-only file or revive removed source tracks', async () => {
    const args = argsFor([video, track(3, 'audio')], { ensureStereo: true });
    args.variables.ffmpegCommand.streams[1]!.removed = true;
    await audio.plugin(args);
    expect(args.variables.ffmpegCommand.streams).toHaveLength(2);
    expect(args.variables.ffmpegCommand.streams[1]!.removed).toBe(true);
  });

  it('changes only default bits, chooses main rather than commentary, and leaves the probe untouched', async () => {
    const args = argsFor(
      [
        video,
        track(2, 'audio', 'jpn', { disposition: { default: 1, forced: 1 } }),
        track(4, 'audio', 'eng', { disposition: { default: 1, comment: 1 } }),
        track(6, 'audio', 'eng', { disposition: { default: 0, hearing_impaired: 1 } }),
      ],
      { defaultLanguage: 'eng' },
    );
    const probe = structuredClone(args.inputFileObj.ffProbeData);
    await audio.plugin(args);
    const streams = kept(args, 'audio');
    expect(streams.map((stream) => stream.disposition)).toEqual([
      { default: 0, forced: 1 },
      { default: 0, comment: 1 },
      { default: 1, hearing_impaired: 1 },
    ]);
    expect(streams.map((stream) => stream.outputArgs)).toEqual([
      ['-disposition:{outputIndex}', '-default'],
      ['-disposition:{outputIndex}', '-default'],
      ['-disposition:{outputIndex}', '+default'],
    ]);
    expect(argv(args)).toContain('copy');
    expect(args.inputFileObj.ffProbeData).toEqual(probe);
    const before = structuredClone(args.variables.ffmpegCommand);
    await audio.plugin(args);
    expect(args.variables.ffmpegCommand).toEqual(before);
  });

  it('keeps a matching current default and emits no arguments when already conforming', async () => {
    const args = argsFor(
      [
        video,
        track(1, 'audio', 'eng'),
        track(2, 'audio', 'eng', { disposition: { default: '1' } }),
      ],
      { defaultLanguage: 'en' },
    );
    await audio.plugin(args);
    expect(changes(args)).toEqual([]);
  });

  it('preserves defaults when the preferred language is absent', async () => {
    const args = argsFor(undefined, { defaultLanguage: 'jpn' });
    await audio.plugin(args);
    expect(changes(args)).toEqual([]);
    expect(args.jobLog).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
  });

  it('adds stereo once, preserving sparse/reordered maps, cover art, data, and untouched audio', async () => {
    const args = argsFor(
      [
        {
          index: 9,
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 40,
          height: 40,
          disposition: { attached_pic: 1 },
        },
        track(7, 'audio', 'eng', { disposition: { default: 1 } }),
        { ...video, index: 2 },
        track(12, 'audio', 'jpn'),
        { index: 20, codec_type: 'data', codec_name: 'bin_data' },
      ],
      { ensureStereo: 'true', stereoBitrate: '256' },
    );
    await audio.plugin(args);
    const command = args.variables.ffmpegCommand;
    const clone = command.streams.at(-1)!;
    expect(clone.mapArgs).toEqual(['-map', '0:7']);
    expect(clone.tags?.language).toBe('eng');
    expect(clone.disposition).toEqual({ default: 0 });
    expect(clone.forceEncoding).toBe(true);
    expect(command.streams[0]!.codec_type).toBe('attachment');
    const compiled = argv(args);
    expect(compiled).toEqual([
      '-i',
      '/movie.mkv',
      '-map',
      '0:9',
      '-c:0',
      'copy',
      '-map',
      '0:7',
      '-c:1',
      'copy',
      '-map',
      '0:2',
      '-c:2',
      'copy',
      '-map',
      '0:12',
      '-c:3',
      'copy',
      '-map',
      '0:20',
      '-c:4',
      'copy',
      '-map',
      '0:7',
      '-c:5',
      'aac',
      '-ac:5',
      '2',
      '-b:5',
      '256k',
      '-metadata:s:5',
      'title=Stereo compatibility',
      '-disposition:5',
      '-default',
      '/output.mkv',
    ]);
    await audio.plugin(args);
    expect(command.streams).toHaveLength(6);
  });

  it.each([true, false])(
    'preserves a custom map or compiler fallback (custom=%s)',
    async (custom) => {
      const args = argsFor([video, track(7, 'audio')], { ensureStereo: true });
      args.variables.ffmpegCommand.streams[1]!.mapArgs = custom ? ['-map', '1:3'] : [];
      await audio.plugin(args);
      expect(args.variables.ffmpegCommand.streams.at(-1)!.mapArgs).toEqual([
        '-map',
        custom ? '1:3' : '0:7',
      ]);
    },
  );

  it('uses array position when a partial probe and empty map have no input index', async () => {
    const args = argsFor([video, track(3, 'audio', 'eng', { index: undefined })], {
      ensureStereo: true,
    });
    args.variables.ffmpegCommand.streams[1]!.mapArgs = [];
    await audio.plugin(args);
    expect(args.variables.ffmpegCommand.streams.at(-1)!.mapArgs).toEqual(['-map', '0:1']);
  });

  it('selects preferred language, but does not mistake another language or commentary AAC for main audio', async () => {
    const args = argsFor(
      [
        video,
        track(1, 'audio', 'jpn', { codec_name: 'aac', channels: 2, disposition: { default: 1 } }),
        track(2, 'audio', 'eng', {
          codec_name: 'aac',
          channels: 2,
          tags: { language: 'eng', title: 'Commentary' },
        }),
        track(3, 'audio', 'eng'),
      ],
      { defaultLanguage: 'eng', ensureStereo: true },
    );
    await audio.plugin(args);
    expect(args.variables.ffmpegCommand.streams.at(-1)!.mapArgs).toEqual(['-map', '0:3']);
  });

  it('can use a commentary-only source without generating another duplicate on repeat', async () => {
    const args = argsFor(
      [
        video,
        track(3, 'audio', 'eng', { tags: { language: 'eng', title: 'Director commentary' } }),
      ],
      { ensureStereo: true },
    );
    await audio.plugin(args);
    await audio.plugin(args);
    expect(kept(args, 'audio')).toHaveLength(2);
    expect(kept(args, 'audio')[1]!.tags?.title).toContain('commentary');
  });

  it('accepts existing stereo AAC at any bitrate and ignores inactive bitrate settings', async () => {
    const args = argsFor(
      [video, track(1, 'audio', 'eng', { codec_name: 'aac', channels: 2, bit_rate: 64000 })],
      { ensureStereo: true, stereoBitrate: 256 },
    );
    await audio.plugin(args);
    expect(changes(args)).toEqual([]);
    await audio.plugin({ ...args, inputs: { stereoBitrate: 'not a bitrate' } });
    expect(changes(args)).toEqual([]);
  });

  it('is a no-op on a transformed probe, including the generated compatibility track', async () => {
    const args = argsFor(
      [
        video,
        track(1, 'audio', 'eng', { disposition: { default: 1 } }),
        track(2, 'audio', 'eng', { codec_name: 'aac', channels: 2, disposition: { default: 0 } }),
      ],
      { languages: 'eng', defaultLanguage: 'en', ensureStereo: true },
    );
    await audio.plugin(args);
    expect(changes(args)).toEqual([]);
    expect(args.variables.ffmpegCommand.shouldProcess).toBe(false);
  });

  it('recognizes stereo AAC already configured by an earlier node', async () => {
    const args = argsFor(undefined, { ensureStereo: true });
    const source = kept(args, 'audio')[0]!;
    source.outputArgs.push('-codec:{outputIndex}', 'libfdk_aac', '-ac:{outputIndex}', '2');
    source.forceEncoding = true;
    await audio.plugin(args);
    expect(kept(args, 'audio')).toHaveLength(1);
  });

  it('does not count AAC that a previous node will turn into a different codec or channel count', async () => {
    const args = argsFor([video, track(1, 'audio', 'eng', { codec_name: 'aac', channels: 2 })], {
      ensureStereo: true,
    });
    kept(args, 'audio')[0]!.outputArgs.push('-c:{outputIndex}', 'ac3', '-ac:{outputIndex}', '6');
    await audio.plugin(args);
    expect(kept(args, 'audio')).toHaveLength(2);
    expect(kept(args, 'audio')[1]!.outputArgs).not.toContain('ac3');
  });

  it('honors pending language/default labels and carries those labels to the cloned track', async () => {
    const args = argsFor([video, track(1, 'audio', 'jpn')], {
      languages: 'eng',
      defaultLanguage: 'eng',
      ensureStereo: true,
    });
    const source = kept(args, 'audio')[0]!;
    source.outputArgs.push(
      '-metadata:s:{outputIndex}',
      'language=eng',
      '-disposition:{outputIndex}',
      'default+forced',
    );
    await audio.plugin(args);
    expect(source.outputArgs).toEqual([
      '-metadata:s:{outputIndex}',
      'language=eng',
      '-disposition:{outputIndex}',
      'default+forced',
    ]);
    expect(kept(args, 'audio')[1]!.outputArgs).toContain('language=eng');
    const before = structuredClone(args.variables.ffmpegCommand);
    await audio.plugin(args);
    expect(args.variables.ffmpegCommand).toEqual(before);
  });

  it('overrides a pending cleared default instead of trusting the old probe bit', async () => {
    const args = argsFor([video, track(1, 'audio', 'eng', { disposition: { default: 1 } })], {
      defaultLanguage: 'eng',
    });
    kept(args, 'audio')[0]!.outputArgs.push('-disposition:{outputIndex}', '0');
    await audio.plugin(args);
    expect(kept(args, 'audio')[0]!.outputArgs.at(-1)).toBe('+default');
  });

  it.each([
    { languageMode: 'drop' },
    { languageMode: 1 },
    { languages: 1 },
    { languages: 'eng,,jpn' },
    { languages: 'eng;rm' },
    { languages: 'not-a-language' },
    { defaultLanguage: 'eng,jpn' },
    { defaultLanguage: false },
    { ensureStereo: 'yes' },
    { ensureStereo: null },
    ...[0, 31, 513, 128.5, '', '128k', null, {}, true].map((stereoBitrate) => ({
      ensureStereo: true,
      stereoBitrate,
    })),
  ])('rejects malformed inputs before mutation: %j', async (inputs) => {
    const args = argsFor(undefined, inputs);
    const before = structuredClone(args.variables.ffmpegCommand);
    await expect(audio.plugin(args)).rejects.toThrow();
    expect(args.variables.ffmpegCommand).toEqual(before);
  });
});

describe('Subtitle Tracks', () => {
  it('filters by language then forced disposition without touching other stream types', async () => {
    const args = argsFor(
      [
        video,
        track(2, 'audio', 'jpn'),
        track(3, 'subtitle', 'eng', { disposition: { forced: '1', default: 0 } }),
        track(4, 'subtitle', 'eng', { tags: { language: 'eng', title: 'Forced (not flagged)' } }),
        track(5, 'subtitle', 'jpn', { disposition: { forced: 1, default: 1 } }),
        { index: 6, codec_type: 'attachment', codec_name: 'ttf' },
        { index: 7, codec_type: 'data', codec_name: 'bin_data' },
      ],
      { languages: 'en', forcedOnly: 'true', defaultLanguage: 'eng' },
    );
    await subtitles.plugin(args);
    expect(kept(args, 'subtitle').map((stream) => stream.index)).toEqual([3]);
    expect(kept(args, 'subtitle')[0]!.disposition).toEqual({ forced: '1', default: 1 });
    expect(kept(args, 'audio')).toHaveLength(1);
    expect(kept(args, 'attachment')).toHaveLength(1);
    expect(kept(args, 'data')).toHaveLength(1);
    expect(argv(args)).toContain('-disposition:2');
  });

  it('supports remove language mode and never revives removed subtitles', async () => {
    const args = argsFor(
      [
        video,
        track(1, 'subtitle', 'eng'),
        track(2, 'subtitle', 'jpn'),
        track(3, 'subtitle', 'fra'),
      ],
      { languageMode: 'remove', languages: 'jpn', defaultLanguage: 'eng' },
    );
    args.variables.ffmpegCommand.streams[1]!.removed = true;
    await subtitles.plugin(args);
    expect(kept(args, 'subtitle').map((stream) => stream.index)).toEqual([3]);
    expect(args.variables.ffmpegCommand.streams[1]!.removed).toBe(true);
  });

  it('allows explicit remove-all and ignores its inactive controls', async () => {
    const args = argsFor(
      [video, track(1, 'audio'), track(2, 'subtitle'), track(3, 'subtitle', 'jpn')],
      {
        removeAll: true,
        languages: {},
        forcedOnly: 'invalid',
        defaultLanguage: 'invalid',
      },
    );
    await subtitles.plugin(args);
    expect(kept(args, 'subtitle')).toHaveLength(0);
    expect(kept(args, 'audio')).toHaveLength(1);
    expect(argv(args)).not.toContain('0:2');
  });

  it('allows forced-only to remove every subtitle if no forced tracks exist', async () => {
    const args = argsFor([video, track(1, 'subtitle')], { forcedOnly: true });
    await subtitles.plugin(args);
    expect(kept(args, 'subtitle')).toHaveLength(0);
  });

  it.each([{ removeAll: true }, { forcedOnly: true }, { languages: 'jpn' }, {}])(
    'is a no-op when the source has no subtitles: %j',
    async (inputs) => {
      const args = argsFor(undefined, inputs);
      await subtitles.plugin(args);
      expect(changes(args)).toEqual([]);
    },
  );

  it('is a no-op on a transformed forced/default probe', async () => {
    const args = argsFor(
      [video, track(1, 'subtitle', 'eng', { disposition: { forced: 1, default: 1 } })],
      { languages: 'eng', forcedOnly: true, defaultLanguage: 'en' },
    );
    await subtitles.plugin(args);
    expect(changes(args)).toEqual([]);
  });

  it.each([
    { removeAll: 'yes' },
    { forcedOnly: 1 },
    { languages: ['eng'] },
    { languageMode: 'bad' },
  ])('rejects malformed input: %j', async (inputs) => {
    await expect(subtitles.plugin(argsFor(undefined, inputs))).rejects.toThrow();
  });
});

describe('Set Container', () => {
  it.each(['mp4', 'mov', 'mkv', 'webm'])(
    'selects %s using copy-only arguments and converges',
    async (target) => {
      const streams =
        target === 'webm'
          ? [{ ...video, codec_name: 'vp9' }, track(1, 'audio', 'eng', { codec_name: 'opus' })]
          : [video, track(1, 'audio', 'eng', { codec_name: 'aac' })];
      const args = argsFor(streams, { container: target }, 'avi');
      await container.plugin(args);
      expect(args.variables.ffmpegCommand.container).toBe(target);
      expect(changes(args).map((change) => change.kind)).toEqual(['container']);
      expect(argv(args)).toContain('copy');
      expect(
        args.variables.ffmpegCommand.streams.every(
          (stream) => !stream.forceEncoding && stream.outputArgs.length === 0,
        ),
      ).toBe(true);
      const repeat = argsFor(streams, { container: ` .${target.toUpperCase()} ` }, target);
      await container.plugin(repeat);
      expect(changes(repeat)).toEqual([]);
      expect(repeat.variables.ffmpegCommand.shouldProcess).toBe(false);
    },
  );

  it.each(['mp4', 'mov'])(
    'rejects copying SRT subtitles to %s without changing anything',
    async (target) => {
      const args = argsFor([video, track(1, 'subtitle')], { container: target });
      const before = structuredClone(args.variables.ffmpegCommand);
      await expect(container.plugin(args)).rejects.toThrow(/subrip.*compatible container/);
      expect(args.variables.ffmpegCommand).toEqual(before);
    },
  );

  it('accepts explicitly removed incompatible subtitles and keeps audio', async () => {
    const args = argsFor([video, track(1, 'audio'), track(2, 'subtitle')], { container: 'mp4' });
    args.variables.ffmpegCommand.streams[2]!.removed = true;
    await container.plugin(args);
    expect(args.variables.ffmpegCommand.container).toBe('mp4');
    expect(kept(args, 'audio')).toHaveLength(1);
  });

  it('rejects AAC or H264 in webm with an actionable message', async () => {
    await expect(container.plugin(argsFor(undefined, { container: 'webm' }))).rejects.toThrow(
      /h264.*webm/,
    );
    await expect(
      container.plugin(
        argsFor(
          [{ ...video, codec_name: 'vp9' }, track(1, 'audio', 'eng', { codec_name: 'aac' })],
          { container: 'webm' },
        ),
      ),
    ).rejects.toThrow(/aac.*webm/);
  });

  it.each(['libvpx-vp9', 'vp9_qsv'])(
    'checks a preceding explicit %s encoder rather than source codec',
    async (encoder) => {
      const args = argsFor([video], { container: 'webm' });
      args.variables.ffmpegCommand.streams[0]!.outputArgs.push('-c:{outputIndex}', encoder);
      args.variables.ffmpegCommand.streams[0]!.forceEncoding = true;
      await container.plugin(args);
      expect(args.variables.ffmpegCommand.container).toBe('webm');
    },
  );

  it('checks explicit stream-copy against the source codec', async () => {
    const args = argsFor([video], { container: 'webm' });
    args.variables.ffmpegCommand.streams[0]!.outputArgs.push('-c:{outputIndex}', 'copy');
    await expect(container.plugin(args)).rejects.toThrow('h264');
  });

  it.each(['forced', 'filter', 'global'])(
    'rejects unverifiable %s encoding instead of trusting the source codec',
    async (mode) => {
      const args = argsFor([video], { container: 'mp4' });
      const command = args.variables.ffmpegCommand;
      if (mode === 'forced') command.streams[0]!.forceEncoding = true;
      if (mode === 'filter')
        command.streams[0]!.outputArgs.push('-filter:{outputIndex}', 'scale=100:100');
      if (mode === 'global') command.overallOuputArguments.push('-c:v', 'vp9');
      await expect(container.plugin(args)).rejects.toThrow('per-stream encoder');
    },
  );

  it.each(['constructor', 'toString'])(
    'gives supported-format guidance for prototype key %s',
    async (target) => {
      await expect(container.plugin(argsFor(undefined, { container: target }))).rejects.toThrow(
        'supports mkv, mp4, mov, or webm',
      );
    },
  );

  it('preserves cover art in mp4 and fonts in mkv; rejects rather than drops incompatible attachments', async () => {
    const cover = {
      index: 2,
      codec_type: 'video',
      codec_name: 'mjpeg',
      width: 50,
      height: 50,
      disposition: { attached_pic: 1 },
    };
    const args = argsFor([cover, video], { container: 'mp4' });
    await container.plugin(args);
    expect(argv(args)).toContain('0:2');
    expect(args.variables.ffmpegCommand.streams[0]!.codec_type).toBe('attachment');
    const font = { index: 3, codec_type: 'attachment', codec_name: 'ttf' };
    await container.plugin(argsFor([video, font], { container: 'mkv' }, 'avi'));
    await expect(container.plugin(argsFor([video, font], { container: 'mp4' }))).rejects.toThrow(
      'attachment',
    );
    await expect(
      container.plugin(argsFor([cover, { ...video, codec_name: 'vp9' }], { container: 'webm' })),
    ).rejects.toThrow('mjpeg');
  });

  it.each(['mkv', 'mov'])(
    'refuses to lose the attached-picture role when remuxing to %s',
    async (target) => {
      const cover = {
        index: 2,
        codec_type: 'video',
        codec_name: 'mjpeg',
        width: 50,
        height: 50,
        disposition: { attached_pic: 1 },
      };
      await expect(
        container.plugin(argsFor([video, cover], { container: target }, 'mp4')),
      ).rejects.toThrow('cannot preserve attached cover art');
      const same = argsFor([video, cover], { container: target }, target);
      await container.plugin(same);
      expect(changes(same)).toEqual([]);
      same.variables.ffmpegCommand.streams[0]!.outputArgs.push(
        '-metadata:s:{outputIndex}',
        'title=Changed',
      );
      await expect(container.plugin(same)).rejects.toThrow('cannot preserve attached cover art');
    },
  );

  it('rejects unsupported retained data without silently removing it', async () => {
    const args = argsFor([video, { index: 3, codec_type: 'data', codec_name: 'bin_data' }], {
      container: 'mp4',
    });
    await expect(container.plugin(args)).rejects.toThrow('data stream 3');
    expect(args.variables.ffmpegCommand.streams[1]!.removed).toBe(false);
  });

  it.each(['avi', 'constructor', 'toString', 'mp4;rm', 1, null])(
    'rejects unsupported or malformed container %s',
    async (target) => {
      await expect(container.plugin(argsFor(undefined, { container: target }))).rejects.toThrow();
    },
  );
});
