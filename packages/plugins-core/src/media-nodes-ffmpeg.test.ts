import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginFfmpegCommand, compileFfmpegArgs, describeCommandChanges } from '@trawlarr/core';
import type { PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { ffmpegAvailableSync } from '../../../test-support/tool-availability.js';
import { plugin as audioTracks } from './audioTracks/index.js';
import { plugin as subtitleTracks } from './subtitleTracks/index.js';
import { plugin as setContainer } from './setContainer/index.js';

const exec = promisify(execFile);
const ffmpeg = async (args: string[]): Promise<void> => {
  await exec('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-filter_threads', '1', ...args]);
};
const probe = async (path: string): Promise<ProbeData> => {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    path,
  ]);
  return JSON.parse(stdout) as ProbeData;
};
const videoHashes = async (path: string): Promise<string[]> => {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_packets',
    '-show_data_hash',
    'sha256',
    '-show_entries',
    'packet=data_hash',
    '-of',
    'json',
    path,
  ]);
  return (JSON.parse(stdout) as { packets: { data_hash: string }[] }).packets.map(
    (packet) => packet.data_hash,
  );
};
const argsFor = async (path: string, container: string): Promise<PluginInputArgs> => {
  const data = await probe(path);
  const file = { _id: path, container, ffProbeData: data };
  return {
    inputFileObj: file,
    originalLibraryFile: file,
    inputs: {},
    variables: {
      ffmpegCommand: beginFfmpegCommand({ probe: data, container, inputPath: path }),
      flowFailed: false,
      user: {},
    },
    jobLog: () => {},
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
const encode = async (args: PluginInputArgs, outputPath: string): Promise<void> =>
  ffmpeg(compileFfmpegArgs({ command: args.variables.ffmpegCommand, outputPath }));

describe.runIf(ffmpegAvailableSync())('first-party media nodes with generated media', () => {
  let directory: string;
  beforeEach(async () => {
    // Keep generated fixtures in the worktree, never in a shared system temp directory.
    directory = join(process.cwd(), `.media-node-fixtures-${randomUUID()}`);
    await mkdir(directory);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const generate = async (output: string, videoCodec = 'libx264', audioCodec = 'aac') => {
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=1:size=96x64:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1:sample_rate=48000',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      videoCodec,
      '-threads',
      '1',
      '-c:a',
      audioCodec,
      '-metadata:s:a:0',
      'language=eng',
      output,
    ]);
  };

  it('filters, selects defaults, and adds exactly one stereo track, then does no work on the result', async () => {
    const source = join(directory, 'source.mkv');
    const output = join(directory, 'selected.mkv');
    const subtitle = join(directory, 'captions.srt');
    await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:00,800\nA generated caption\n');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=1:size=96x64:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1:sample_rate=48000',
      '-i',
      subtitle,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '1:a',
      '-map',
      '1:a',
      '-map',
      '2:s',
      '-map',
      '2:s',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-c:a:0',
      'ac3',
      '-ac:a:0',
      '6',
      '-c:a:1',
      'ac3',
      '-c:a:2',
      'aac',
      '-ac:a:2',
      '2',
      '-c:s',
      'srt',
      '-metadata:s:a:0',
      'language=eng',
      '-disposition:a:0',
      '0',
      '-metadata:s:a:1',
      'language=jpn',
      '-disposition:a:1',
      'default',
      '-metadata:s:a:2',
      'language=eng',
      '-metadata:s:a:2',
      'title=Director commentary',
      '-disposition:a:2',
      'comment',
      '-metadata:s:s:0',
      'language=eng',
      '-disposition:s:0',
      'forced',
      '-metadata:s:s:1',
      'language=jpn',
      '-disposition:s:1',
      'default',
      source,
    ]);
    const configure = async (args: PluginInputArgs) => {
      args.inputs = {
        languages: 'eng',
        defaultLanguage: 'eng',
        ensureStereo: true,
        stereoBitrate: 128,
      };
      await audioTracks(args);
      args.inputs = { languages: 'eng', forcedOnly: true, defaultLanguage: 'eng' };
      await subtitleTracks(args);
      args.inputs = { container: 'mkv' };
      await setContainer(args);
    };
    const args = await argsFor(source, 'mkv');
    await configure(args);
    expect(changes(args).length).toBeGreaterThan(0);
    await encode(args, output);
    const streams = (await probe(output)).streams!;
    const audio = streams.filter((stream) => stream.codec_type === 'audio');
    expect(audio).toHaveLength(3);
    expect(audio.every((stream) => stream.tags?.language === 'eng')).toBe(true);
    expect(audio.map((stream) => [stream.codec_name, stream.channels])).toEqual([
      ['ac3', 6],
      ['aac', 2],
      ['aac', 2],
    ]);
    expect(audio.map((stream) => (stream.disposition as { default: number }).default)).toEqual([
      1, 0, 0,
    ]);
    expect(audio[1]!.tags?.title).toBe('Director commentary');
    const captions = streams.filter((stream) => stream.codec_type === 'subtitle');
    expect(captions).toHaveLength(1);
    expect(captions[0]!.disposition).toMatchObject({ forced: 1, default: 1 });
    expect(await videoHashes(output)).toEqual(await videoHashes(source));
    const repeat = await argsFor(output, 'mkv');
    await configure(repeat);
    expect(changes(repeat)).toEqual([]);
    expect(repeat.variables.ffmpegCommand.shouldProcess).toBe(false);
  });

  it.each(['mp4', 'mov'])('remuxes untouched streams to %s and converges', async (container) => {
    const source = join(directory, 'source.mkv');
    const output = join(directory, `output.${container}`);
    await generate(source);
    const args = await argsFor(source, 'mkv');
    args.inputs = { container };
    await setContainer(args);
    await encode(args, output);
    expect((await probe(output)).streams!.map((stream) => stream.codec_name)).toEqual([
      'h264',
      'aac',
    ]);
    expect(await videoHashes(output)).toEqual(await videoHashes(source));
    const repeat = await argsFor(output, container);
    repeat.inputs = { container };
    await setContainer(repeat);
    expect(changes(repeat)).toEqual([]);
  });

  it('remuxes compatible VP9/Opus to webm and rejects adding AAC before writing', async () => {
    const source = join(directory, 'source.mkv');
    const output = join(directory, 'output.webm');
    await generate(source, 'libvpx-vp9', 'libopus');
    const args = await argsFor(source, 'mkv');
    args.inputs = { container: 'webm' };
    await setContainer(args);
    await encode(args, output);
    expect(await videoHashes(output)).toEqual(await videoHashes(source));
    const repeat = await argsFor(output, 'webm');
    repeat.inputs = { container: 'webm' };
    await setContainer(repeat);
    expect(changes(repeat)).toEqual([]);
    repeat.inputs = { ensureStereo: true };
    await audioTracks(repeat);
    repeat.inputs = { container: 'webm' };
    await expect(setContainer(repeat)).rejects.toThrow(/aac.*webm/);
  });

  it('keeps attached cover art and video copied while adding stereo AAC to mp4', async () => {
    const base = join(directory, 'base.mkv');
    const poster = join(directory, 'poster.jpg');
    const source = join(directory, 'source.mp4');
    const output = join(directory, 'output.mp4');
    await generate(base);
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=32x32',
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      '-threads',
      '1',
      poster,
    ]);
    await ffmpeg([
      '-i',
      base,
      '-i',
      poster,
      '-map',
      '0',
      '-map',
      '1:v',
      '-c',
      'copy',
      '-disposition:v:1',
      'attached_pic',
      source,
    ]);
    const args = await argsFor(source, 'mp4');
    args.inputs = { ensureStereo: true };
    await audioTracks(args);
    args.inputs = { container: 'mp4' };
    await setContainer(args);
    await encode(args, output);
    const streams = (await probe(output)).streams!;
    expect(
      streams.filter((stream) => stream.codec_type === 'video').map((stream) => stream.codec_name),
    ).toEqual(['h264', 'mjpeg']);
    expect(streams.find((stream) => stream.codec_name === 'mjpeg')!.disposition).toMatchObject({
      attached_pic: 1,
    });
    expect(
      streams.filter((stream) => stream.codec_type === 'audio').map((stream) => stream.channels),
    ).toEqual([1, 2]);
    expect(await videoHashes(output)).toEqual(await videoHashes(source));
    const repeat = await argsFor(output, 'mp4');
    repeat.inputs = { ensureStereo: true };
    await audioTracks(repeat);
    expect(changes(repeat)).toEqual([]);
    for (const container of ['mkv', 'mov']) {
      repeat.inputs = { container };
      await expect(setContainer(repeat)).rejects.toThrow('cannot preserve attached cover art');
    }
  });
});
