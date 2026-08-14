import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProbeError, probeFile } from './ffprobe.js';

const execFileAsync = promisify(execFile);
let media: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-probe-'));
  media = join(dir, 'sample.mkv');
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
    '-c:a',
    'aac',
    media,
  ]);
}, 60_000);

describe('probeFile', () => {
  it('returns the streams and format ffprobe reports', async () => {
    const probe = await probeFile({ ffprobePath: 'ffprobe', path: media });
    expect(probe.streams?.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
    expect(probe.format?.duration).toBeDefined();
  });

  it('preserves each stream index, which identity and mapping depend on', async () => {
    const probe = await probeFile({ ffprobePath: 'ffprobe', path: media });
    expect(probe.streams?.map((s) => s.index)).toEqual([0, 1]);
  });

  it('fails with the path named when the file is not media', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trawlarr-probe-'));
    const notMedia = join(dir, 'notes.txt');
    await execFileAsync('bash', ['-c', `echo hello > ${notMedia}`]);
    await expect(probeFile({ ffprobePath: 'ffprobe', path: notMedia })).rejects.toThrow(ProbeError);
    await expect(probeFile({ ffprobePath: 'ffprobe', path: notMedia })).rejects.toThrow(
      /notes\.txt/,
    );
  });

  it('fails with the path named when the file is absent', async () => {
    await expect(probeFile({ ffprobePath: 'ffprobe', path: '/nope/x.mkv' })).rejects.toThrow(
      /x\.mkv/,
    );
  });

  it('fails clearly when ffprobe itself cannot be run', async () => {
    await expect(probeFile({ ffprobePath: '/nonexistent-ffprobe', path: media })).rejects.toThrow(
      ProbeError,
    );
  });
});
