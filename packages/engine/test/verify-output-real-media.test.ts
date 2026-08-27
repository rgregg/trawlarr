import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { verifyOutput } from '../src/executor/verify-output.js';
import { ffmpegAvailableSync } from '../../../test-support/tool-availability.js';

const execFileAsync = promisify(execFile);

// Computed SYNCHRONOUSLY at module scope: `describe.runIf` reads its condition
// at collection time, so a check set inside `beforeAll` always reads false and
// skips the suite silently. `ffmpegAvailableSync` answers false only for a
// genuine ENOENT and throws otherwise.
const available = ffmpegAvailableSync();

let workDir = '';
let sourcePath = '';

const probeOf = async (path: string): Promise<ProbeData> => {
  const { stdout } = await execFileAsync('ffprobe', [
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

/**
 * The shape of the files that exposed the defect, in miniature: picture, an
 * English track, and an Italian dub that OVERHANGS the picture — so the
 * Matroska container reports the dub's length as the file's length.
 */
const makeSample = async (path: string) => {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=24:duration=5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=7',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-metadata:s:a:0',
    'language=eng',
    '-metadata:s:a:1',
    'language=ita',
    path,
  ]);
};

const sizesAndGates = (outputPath: string) => ({
  outputSizeBytes: statSync(outputPath).size,
  originalSizeBytes: statSync(sourcePath).size,
  durationToleranceSeconds: 1,
  minSizeRatio: 0.05,
  requireAudioIfOriginalHadAudio: true,
});

beforeAll(async () => {
  if (!available) return;
  workDir = mkdtempSync(join(tmpdir(), 'trawlarr-verify-'));
  sourcePath = join(workDir, 'Sample.mkv');
  await makeSample(sourcePath);
}, 120_000);

describe.runIf(available)('verification against a real overhanging dub', () => {
  it('really produces the shape the unit fixtures assume', async () => {
    // The load-bearing assumption of the whole fix, checked against a real
    // ffprobe rather than assumed: in Matroska every stream reports
    // `duration` as absent and carries its real length in a DURATION TAG,
    // and the CONTAINER reports its longest stream — the dub, not the film.
    const probe = await probeOf(sourcePath);
    const streams = probe.streams ?? [];
    expect(streams.map((stream) => stream.duration)).toEqual([undefined, undefined, undefined]);
    for (const stream of streams) {
      expect(String(stream.tags?.DURATION)).toMatch(/^\d\d:\d\d:\d\d\.\d+$/);
    }
    const video = streams.find((stream) => stream.codec_type === 'video');
    expect(String(video?.tags?.DURATION)).toBe('00:00:05.000000000');
    // The container is the 7s dub, over a 5s film. That 2s gap is the defect.
    expect(Number(probe.format?.duration)).toBeGreaterThan(6.9);
  }, 120_000);

  it('passes an output whose only loss is the overhanging dub', async () => {
    const outputPath = join(workDir, 'no-dub.mkv');
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i',
      sourcePath,
      '-map',
      '0:v',
      '-map',
      '0:a:0',
      '-c',
      'copy',
      outputPath,
    ]);

    const originalProbe = await probeOf(sourcePath);
    const probe = await probeOf(outputPath);
    // The container really did shrink by more than the 1s tolerance, which is
    // what used to fail this file.
    const containerLoss = Number(originalProbe.format?.duration) - Number(probe.format?.duration);
    expect(containerLoss).toBeGreaterThan(1);

    const report = verifyOutput({
      ...sizesAndGates(outputPath),
      probe,
      originalProbe,
      intendedStreamCount: 2,
    });

    expect(report.reasons).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.duration.basis).toBe('video');
    // The picture is intact. Not bit-identical: a remux rewrites the DURATION
    // tag from the last frame's timing, which moves it by a few tens of
    // milliseconds — two orders of magnitude inside the tolerance, and two
    // orders BELOW the container's loss above.
    expect(Math.abs(report.duration.originalSeconds - report.duration.outputSeconds)).toBeLessThan(
      0.1,
    );
  }, 120_000);

  it('still fails a genuinely truncated encode of the same file', async () => {
    const outputPath = join(workDir, 'truncated.mkv');
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i',
      sourcePath,
      '-map',
      '0:v',
      '-map',
      '0:a:0',
      '-t',
      '2',
      '-c',
      'copy',
      outputPath,
    ]);

    const originalProbe = await probeOf(sourcePath);
    const probe = await probeOf(outputPath);
    const report = verifyOutput({
      ...sizesAndGates(outputPath),
      probe,
      originalProbe,
      intendedStreamCount: 2,
    });

    expect(report.ok).toBe(false);
    expect(report.duration.basis).toBe('video');
    expect(report.duration.originalSeconds - report.duration.outputSeconds).toBeGreaterThan(2.5);
  }, 120_000);
});
