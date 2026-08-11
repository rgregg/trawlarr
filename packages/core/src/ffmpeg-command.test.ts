import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import {
  FfmpegCommandStateError,
  assertCommandInitialised,
  beginFfmpegCommand,
  closeFfmpegCommand,
  emptyFfmpegCommand,
} from './ffmpeg-command.js';

const probe: ProbeData = {
  streams: [
    { codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'eac3' },
  ],
};

describe('emptyFfmpegCommand', () => {
  it('starts uninitialised with the contract-spelled keys present', () => {
    const cmd = emptyFfmpegCommand();
    expect(cmd.init).toBe(false);
    expect(cmd.shouldProcess).toBe(false);
    expect(cmd.overallOuputArguments).toEqual([]);
  });
});

describe('beginFfmpegCommand', () => {
  it('initialises from the probe and the input path', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    expect(cmd.init).toBe(true);
    expect(cmd.container).toBe('mkv');
    expect(cmd.inputFiles).toEqual(['/in.mkv']);
  });

  it('seeds one mutable stream per probe stream, all kept by default', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    expect(cmd.streams).toHaveLength(2);
    expect(cmd.streams[0]).toMatchObject({
      codec_name: 'h264',
      removed: false,
      forceEncoding: false,
      inputArgs: [],
      outputArgs: [],
    });
  });

  it('preserves the raw ffprobe fields plugins read', () => {
    const cmd = beginFfmpegCommand({
      probe: { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, index: 0 }] },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    expect(cmd.streams[0]?.width).toBe(1920);
  });

  it('gives each stream its own arg arrays', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    cmd.streams[0]?.outputArgs.push('-c:v', 'hevc');
    expect(cmd.streams[1]?.outputArgs).toEqual([]);
  });

  it('handles a probe with no streams', () => {
    const cmd = beginFfmpegCommand({ probe: {}, container: 'mp4', inputPath: '/in.mp4' });
    expect(cmd.streams).toEqual([]);
    expect(cmd.init).toBe(true);
  });
});

describe('assertCommandInitialised', () => {
  it('passes for an initialised command', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    expect(() => assertCommandInitialised(cmd)).not.toThrow();
  });

  it('explains how to fix an uninitialised command', () => {
    expect(() => assertCommandInitialised(emptyFfmpegCommand())).toThrow(FfmpegCommandStateError);
    expect(() => assertCommandInitialised(emptyFfmpegCommand())).toThrow(/Begin Command/i);
    expect(() => assertCommandInitialised(emptyFfmpegCommand())).toThrow(/Execute/i);
  });
});

describe('closeFfmpegCommand', () => {
  it('clears init so a second command needs a fresh Begin', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    const closed = closeFfmpegCommand(cmd);
    expect(closed.init).toBe(false);
    expect(() => assertCommandInitialised(closed)).toThrow(FfmpegCommandStateError);
  });

  it('also clears shouldProcess, so a stale flag cannot re-trigger work', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    cmd.shouldProcess = true;
    expect(closeFfmpegCommand(cmd).shouldProcess).toBe(false);
  });
});
