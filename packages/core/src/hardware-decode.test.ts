import { describe, expect, it } from 'vitest';
import type { FfmpegCommand } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from './ffmpeg-command.js';
import { compileFfmpegArgs } from './ffmpeg-compile.js';
import {
  HardwareDecodeConflictError,
  applyHardwareDecoding,
  hwaccelForEncoder,
} from './hardware-decode.js';

const command = (): FfmpegCommand =>
  beginFfmpegCommand({
    probe: {
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'eac3' },
      ],
    },
    container: 'mkv',
    inputPath: '/in.mkv',
  });

describe('hwaccelForEncoder', () => {
  it('pairs every NVENC encoder with cuda, by hardware family rather than by name', () => {
    expect(hwaccelForEncoder('hevc_nvenc')).toBe('cuda');
    expect(hwaccelForEncoder('h264_nvenc')).toBe('cuda');
    // Not in any dropdown: the mapping is on the family suffix, so an
    // encoder nobody listed still decodes on the right device.
    expect(hwaccelForEncoder('av1_nvenc')).toBe('cuda');
  });

  it('pairs qsv, vaapi and videotoolbox with their own decode APIs', () => {
    expect(hwaccelForEncoder('hevc_qsv')).toBe('qsv');
    expect(hwaccelForEncoder('hevc_vaapi')).toBe('vaapi');
    expect(hwaccelForEncoder('hevc_videotoolbox')).toBe('videotoolbox');
  });

  it('has no decoder for AMF, which is an encode-only API in ffmpeg', () => {
    expect(hwaccelForEncoder('hevc_amf')).toBeNull();
  });

  it('has no decoder for a software encoder', () => {
    expect(hwaccelForEncoder('libx265')).toBeNull();
    expect(hwaccelForEncoder('libx264')).toBeNull();
    expect(hwaccelForEncoder('libsvtav1')).toBeNull();
  });
});

describe('applyHardwareDecoding', () => {
  it('writes the flag into the overall preamble, where it precedes -i once', () => {
    const cmd = command();
    applyHardwareDecoding(cmd, { hwaccel: 'cuda' });
    expect(cmd.overallInputArguments).toEqual(['-hwaccel', 'cuda']);
    expect(cmd.hardwareDecoding).toBe(true);

    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    // Position is the whole point: -hwaccel is an input option and means
    // nothing after -i, where ffmpeg would read it as an output option.
    expect(args.slice(0, 4)).toEqual(['-hwaccel', 'cuda', '-i', '/in.mkv']);
    expect(args.filter((arg) => arg === '-hwaccel')).toHaveLength(1);
  });

  it('adds -hwaccel_output_format only when asked to keep frames on the device', () => {
    const off = command();
    applyHardwareDecoding(off, { hwaccel: 'cuda' });
    expect(off.overallInputArguments).not.toContain('-hwaccel_output_format');

    const on = command();
    applyHardwareDecoding(on, { hwaccel: 'cuda', outputFormat: true });
    expect(on.overallInputArguments).toEqual([
      '-hwaccel',
      'cuda',
      '-hwaccel_output_format',
      'cuda',
    ]);
  });

  it('is idempotent: two nodes asking for the same decoder emit one flag', () => {
    const cmd = command();
    applyHardwareDecoding(cmd, { hwaccel: 'cuda' });
    applyHardwareDecoding(cmd, { hwaccel: 'cuda' });
    expect(cmd.overallInputArguments).toEqual(['-hwaccel', 'cuda']);
  });

  it('refuses two different decoders rather than letting ffmpeg pick the last one', () => {
    const cmd = command();
    applyHardwareDecoding(cmd, { hwaccel: 'cuda' });
    expect(() => applyHardwareDecoding(cmd, { hwaccel: 'qsv' })).toThrow(
      HardwareDecodeConflictError,
    );
    // The message has to name both, because the fix is choosing between them.
    expect(() => applyHardwareDecoding(cmd, { hwaccel: 'qsv' })).toThrow(/cuda[\s\S]*qsv/);
    // And nothing was written on the way out.
    expect(cmd.overallInputArguments).toEqual(['-hwaccel', 'cuda']);
  });

  it('sees a conflicting -hwaccel a plugin put on a STREAM, which is hoisted to the same place', () => {
    const cmd = command();
    // A community plugin's per-stream inputArgs land in the one preamble
    // ahead of -i, so this is not "another stream's setting" — it is this
    // input's setting, and a second value would silently win or lose.
    cmd.streams[0]!.inputArgs.push('-hwaccel', 'vaapi');
    expect(() => applyHardwareDecoding(cmd, { hwaccel: 'cuda' })).toThrow(
      HardwareDecodeConflictError,
    );
  });

  it('accepts a matching -hwaccel already set on a stream, and does not repeat it', () => {
    const cmd = command();
    cmd.streams[0]!.inputArgs.push('-hwaccel', 'cuda');
    applyHardwareDecoding(cmd, { hwaccel: 'cuda' });
    expect(cmd.overallInputArguments).toEqual([]);
    expect(
      compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' }).filter((a) => a === '-hwaccel'),
    ).toHaveLength(1);
  });

  it('refuses a conflicting -hwaccel_output_format too', () => {
    const cmd = command();
    cmd.overallInputArguments.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'nv12');
    expect(() => applyHardwareDecoding(cmd, { hwaccel: 'cuda', outputFormat: true })).toThrow(
      /nv12[\s\S]*cuda/,
    );
  });
});
