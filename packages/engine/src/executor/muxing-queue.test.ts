import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { beginFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import { toolAvailableSync } from '../../../../test-support/tool-availability.js';
import { MUXING_QUEUE_SIZE_MAX, muxingQueueSizeFrom, withMuxingQueueSize } from './muxing-queue.js';

const execFileAsync = promisify(execFile);
// Read at collection time: `describe.runIf` is decided before any test runs.
const available = toolAvailableSync('ffmpeg');

describe('muxingQueueSizeFrom', () => {
  it('reads an unset input as "leave ffmpeg\'s default alone"', () => {
    expect(muxingQueueSizeFrom(undefined)).toBeNull();
    expect(muxingQueueSizeFrom(null)).toBeNull();
    expect(muxingQueueSizeFrom('')).toBeNull();
    expect(muxingQueueSizeFrom('  ')).toBeNull();
  });

  it('reads a stored string and a typed number the same way', () => {
    expect(muxingQueueSizeFrom('2048')).toBe(2048);
    expect(muxingQueueSizeFrom(2048)).toBe(2048);
  });

  it.each(['abc', '0', '-5', '1.5', String(MUXING_QUEUE_SIZE_MAX + 1)])(
    'refuses %s rather than guessing what was meant',
    (value) => {
      expect(() => muxingQueueSizeFrom(value)).toThrow(/Muxing queue size/);
    },
  );
});

describe('withMuxingQueueSize', () => {
  const argv = ['-i', '/in.mkv', '-map', '0:0', '-c', 'copy', '/out.mkv'];

  it('changes nothing when no size is set', () => {
    expect(withMuxingQueueSize(argv, null)).toEqual(argv);
  });

  it('adds it as an OUTPUT option: after the inputs, immediately before the output path', () => {
    // Placed before `-i` it would apply to the input and ffmpeg would reject it.
    expect(withMuxingQueueSize(argv, 2048)).toEqual([
      ...argv.slice(0, -1),
      '-max_muxing_queue_size',
      '2048',
      '/out.mkv',
    ]);
  });

  it('never mutates the argv it was given', () => {
    const copy = [...argv];
    withMuxingQueueSize(argv, 2048);
    expect(argv).toEqual(copy);
  });
});

describe.runIf(available)('withMuxingQueueSize, against real ffmpeg', () => {
  it('produces a command ffmpeg accepts and runs to completion', async () => {
    // A misplaced output option does not degrade quietly: ffmpeg rejects the
    // whole command, which on a live library would fail every transcode.
    const dir = mkdtempSync(join(tmpdir(), 'trawlarr-muxq-'));
    const source = join(dir, 'source.mkv');
    const output = join(dir, 'output.mkv');
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=64x48:rate=5',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      source,
    ]);
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      source,
    ]);
    const command = beginFfmpegCommand({
      probe: JSON.parse(stdout) as ProbeData,
      container: 'mkv',
      inputPath: source,
    });

    const argv = withMuxingQueueSize(
      compileFfmpegArgs({ command, outputPath: output }),
      muxingQueueSizeFrom('2048'),
    );
    await execFileAsync('ffmpeg', ['-hide_banner', '-y', ...argv]);

    expect(argv).toContain('-max_muxing_queue_size');
    expect(existsSync(output)).toBe(true);
  });
});
