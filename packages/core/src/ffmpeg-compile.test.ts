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

  it('places per-stream outputArgs immediately after that stream map', () => {
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
      '-map',
      '0:2',
      '/out.mkv',
    ]);
  });

  it('drops the blanket copy once any stream specifies its own encoding', () => {
    const cmd = command();
    cmd.streams[0]!.outputArgs.push('-c:v', 'hevc_nvenc');
    expect(compile(cmd)).not.toContain('copy');
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
