import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { guardDurationChange } from '@trawlarr/engine';
import { toolAvailableSync } from '../../../test-support/tool-availability.js';
import { probeFile } from '../src/probe/ffprobe.js';

/**
 * The duration gate in Replace Original File, fed by the SAME probe a worker
 * uses, against real media.
 *
 * The gate's own tests hand it synthetic probes, which prove the decision
 * table and nothing about the input. The input is the risky half: Matroska
 * keeps its per-stream durations in `DURATION` tags rather than numeric
 * fields, and a gate that misread a real mkv would not merely miss a
 * truncation — it would refuse EVERY replacement, since this one has no off
 * switch. So the proof runs both directions on files ffmpeg actually wrote.
 */

const execFileAsync = promisify(execFile);
// Read at collection time: `describe.runIf` is decided before any beforeAll.
const available = toolAvailableSync('ffmpeg');

let dir: string;
const at = (name: string) => join(dir, name);
const probe = (name: string) => probeFile({ ffprobePath: 'ffprobe', path: at(name) });

beforeAll(async () => {
  if (!available) return;
  dir = mkdtempSync(join(tmpdir(), 'trawlarr-duration-gate-'));
  // Thirty seconds: long enough that a truncation clears the gate's 10-second
  // floor, small enough (64x48 at 5 fps) to generate in well under a second.
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=30:size=64x48:rate=5',
    '-f',
    'lavfi',
    '-i',
    'sine=duration=30',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    at('original.mkv'),
  ]);
  const remux = (output: string, extra: string[] = []) =>
    execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i',
      at('original.mkv'),
      ...extra,
      '-c',
      'copy',
      at(output),
    ]);
  await Promise.all([
    // The shape of the incident: an output that simply stops early.
    remux('truncated.mkv', ['-t', '4']),
    // What the gate must never refuse: the same programme, rewrapped.
    remux('remux.mkv'),
    remux('remux.mp4'),
  ]);
}, 60_000);

describe.runIf(available)('the duration gate, on real media', () => {
  it('refuses a real mkv that stopped early', async () => {
    const verdict = guardDurationChange({
      newProbe: await probe('truncated.mkv'),
      originalProbe: await probe('original.mkv'),
    });
    expect(verdict.install).toBe(false);
    // Read, not guessed: both sides produced real numbers.
    expect(verdict.comparison.originalSeconds).toBeCloseTo(30, 0);
    expect(verdict.comparison.outputSeconds).toBeLessThan(6);
  });

  it('installs a faithful mkv remux', async () => {
    const verdict = guardDurationChange({
      newProbe: await probe('remux.mkv'),
      originalProbe: await probe('original.mkv'),
    });
    expect(verdict.install).toBe(true);
    expect(verdict.abstained).toBe(false);
  });

  it('installs a container change to mp4, where durations are read a different way', async () => {
    const verdict = guardDurationChange({
      newProbe: await probe('remux.mp4'),
      originalProbe: await probe('original.mkv'),
    });
    expect(verdict.install).toBe(true);
    expect(verdict.abstained).toBe(false);
  });
});
