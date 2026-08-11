import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from './ffmpeg-command.js';
import { compileFfmpegArgs } from './ffmpeg-compile.js';

const probe: ProbeData = {
  streams: [
    { codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'eac3' },
    { codec_type: 'subtitle', codec_name: 'subrip' },
  ],
};

const command = () => beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
const compile = (cmd = command(), outputPath = '/out.mkv') =>
  compileFfmpegArgs({ command: cmd, outputPath });

describe('compileFfmpegArgs', () => {
  it('maps every stream and copies by default', () => {
    expect(compile()).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-map',
      '0:1',
      '-map',
      '0:2',
      '-c',
      'copy',
      '/out.mkv',
    ]);
  });

  it('omits removed streams', () => {
    const cmd = command();
    cmd.streams[2]!.removed = true;
    expect(compile(cmd)).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-map',
      '0:1',
      '-c',
      'copy',
      '/out.mkv',
    ]);
  });

  it('places per-stream outputArgs immediately after that stream map, and copies untouched streams explicitly', () => {
    const cmd = command();
    cmd.streams[0]!.outputArgs.push('-c:v', 'hevc_nvenc', '-cq', '24');
    expect(compile(cmd)).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-c:v',
      'hevc_nvenc',
      '-cq',
      '24',
      '-map',
      '0:1',
      '-c:1',
      'copy',
      '-map',
      '0:2',
      '-c:2',
      'copy',
      '/out.mkv',
    ]);
  });

  it('drops the blanket copy once any stream specifies its own encoding, replacing it with per-stream copies', () => {
    const cmd = command();
    cmd.streams[0]!.outputArgs.push('-c:v', 'hevc_nvenc');
    const args = compile(cmd);
    // No bare "-c copy" blanket directive anywhere...
    expect(args.join(' ')).not.toContain('-c copy');
    // ...but the untouched streams still get an explicit per-stream copy, so
    // they are never silently handed to ffmpeg's container-default encoder.
    expect(args).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-c:v',
      'hevc_nvenc',
      '-map',
      '0:1',
      '-c:1',
      'copy',
      '-map',
      '0:2',
      '-c:2',
      'copy',
      '/out.mkv',
    ]);
  });

  it('encodes only the video stream, leaving audio and subtitles untouched, with a removed middle stream — asserting -c:<n> refers to OUTPUT stream position, not input index', () => {
    const cmd = command();
    // probe order is [video(0), audio(1), subtitle(2)]. Remove the middle
    // (audio) stream, then encode the video. The surviving streams are
    // video (input 0) and subtitle (input 2); their OUTPUT positions are 0
    // and 1 respectively, which must be what "-c:<n>" refers to — not their
    // input indices (0 and 2).
    cmd.streams[1]!.removed = true;
    cmd.streams[0]!.outputArgs.push('-c:v', 'libx265', '-crf', '30');
    expect(compile(cmd)).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-c:v',
      'libx265',
      '-crf',
      '30',
      '-map',
      '0:2',
      '-c:1',
      'copy',
      '/out.mkv',
    ]);
  });

  it('hoists stream inputArgs ahead of the input', () => {
    const cmd = command();
    cmd.streams[0]!.inputArgs.push('-hwaccel', 'cuda');
    expect(compile(cmd)).toEqual([
      '-hwaccel',
      'cuda',
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-map',
      '0:1',
      '-map',
      '0:2',
      '-c',
      'copy',
      '/out.mkv',
    ]);
  });

  it('wraps with overall input and output arguments, honouring the misspelled key', () => {
    const cmd = command();
    cmd.overallInputArguments.push('-fflags', '+genpts');
    cmd.overallOuputArguments.push('-max_muxing_queue_size', '9999');
    const args = compile(cmd);
    expect(args.slice(0, 2)).toEqual(['-fflags', '+genpts']);
    expect(args.slice(-3)).toEqual(['-max_muxing_queue_size', '9999', '/out.mkv']);
  });

  it('supports multiple inputs with correct file indices', () => {
    const cmd = command();
    cmd.inputFiles.push('/second.mkv');
    const args = compile(cmd);
    expect(args.filter((a: string) => a === '-i')).toHaveLength(2);
    expect(args).toContain('/second.mkv');
  });

  it('puts the output path last', () => {
    expect(compile().at(-1)).toBe('/out.mkv');
  });

  it('refuses to compile an uninitialised command', () => {
    const cmd = command();
    cmd.init = false;
    expect(() => compile(cmd)).toThrow(/Begin Command/i);
  });

  it('refuses to compile with no inputs', () => {
    const cmd = command();
    cmd.inputFiles = [];
    expect(() => compile(cmd)).toThrow(/input file/i);
  });

  it('refuses to compile when every stream was removed', () => {
    const cmd = command();
    for (const stream of cmd.streams) stream.removed = true;
    expect(() => compile(cmd)).toThrow(/every stream/i);
  });
});
