import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// describe.runIf's condition is read at collection time, before any
// beforeAll runs — so the ffmpeg check must be synchronous and done at
// module scope. An async check gated behind beforeAll would always read as
// unavailable and skip the whole suite regardless of whether ffmpeg exists.
const hasFfmpegSync = (): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const available = hasFfmpegSync();
let workDir: string;
let sourceDir: string;
let mediaPath: string;
let convergedPath: string;

// Generate tiny samples rather than committing binary fixtures.
const makeSample = (path: string, videoCodec: string) =>
  execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    videoCodec,
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    path,
  ]);

const audioCodecOf = async (path: string): Promise<string> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'csv=p=0',
    path,
  ]);
  return stdout.trim();
};

const videoCodecOf = async (path: string): Promise<string> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'csv=p=0',
    path,
  ]);
  return stdout.trim();
};

beforeAll(async () => {
  if (!available) return;

  // The inputs live OUTSIDE the work dir. The CLI computes an Execute node's
  // output as <work-dir>/<basename>.<container>, so a source that lives in the
  // work dir would resolve its output onto itself — which the engine now
  // refuses (spec §6.1: never implicitly replace a file). Separating the two
  // directories is what a real deployment does, and it keeps every input in
  // this suite immutable, so no test depends on another having mutated disk.
  workDir = mkdtempSync(join(tmpdir(), 'trawlarr-e2e-'));
  sourceDir = join(workDir, 'source');
  mkdirSync(sourceDir, { recursive: true });
  mediaPath = join(sourceDir, 'sample.mkv');
  convergedPath = join(sourceDir, 'already-hevc.mkv');

  await makeSample(mediaPath, 'libx264');
  // A file that already satisfies the flow's check, built here rather than
  // inherited from the transcode test's output: tests must not depend on each
  // other's side effects, or a failure upstream shows up as a mystery here.
  await makeSample(convergedPath, 'libx265');
}, 120_000);

const flowPath = () => {
  const path = join(workDir, 'flow.json');
  writeFileSync(
    path,
    JSON.stringify({
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
        {
          id: 'check',
          pluginId: 'trawlarr:checkVideoCodec',
          pluginVersion: '1.0.0',
          inputs: { codec: 'hevc' },
        },
        { id: 'begin', pluginId: 'trawlarr:beginCommand', pluginVersion: '1.0.0', inputs: {} },
        {
          id: 'encoder',
          pluginId: 'trawlarr:setVideoEncoder',
          pluginVersion: '1.0.0',
          inputs: { encoder: 'libx265', quality: '30' },
        },
        { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
      ],
      edges: [
        { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
        { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
        { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'encoder' },
        { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'execute' },
      ],
    }),
    'utf8',
  );
  return path;
};

const runCli = (args: string[]) =>
  execFileAsync('node', [join(process.cwd(), 'packages/engine/dist/cli.js'), ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });

describe.runIf(available)('end to end', () => {
  it('dry-runs the flow and reports the ffmpeg command without producing output', async () => {
    const { stdout } = await runCli([
      '--flow',
      flowPath(),
      '--file',
      mediaPath,
      '--dry-run',
      '--work-dir',
      workDir,
    ]);
    expect(stdout).toContain('Would run:');
    expect(stdout).toContain('-c:v libx265');
    expect(stdout).toContain('Stopped: end-of-flow');

    // The dry run must report a command that could actually run: ffmpeg
    // refuses to write the file it is reading, so a report naming the input
    // as the output would describe something that could never execute.
    const match = /Would run: ffmpeg (.+)/.exec(stdout);
    const reportedArgs = match?.[1]?.trim().split(/\s+/) ?? [];
    const reportedOutputPath = reportedArgs.at(-1);
    expect(reportedOutputPath).toBeDefined();
    expect(reportedOutputPath).not.toBe(mediaPath);
  }, 60_000);

  it('transcodes the sample to hevc for real, into a new file', async () => {
    // Captured BEFORE the run: the output is a distinct file, but reading the
    // input's codec up front is what makes the comparison below falsifiable
    // rather than a tautology.
    const inputVideoCodec = await videoCodecOf(mediaPath);
    const inputAudioCodec = await audioCodecOf(mediaPath);
    expect(inputVideoCodec).toBe('h264');
    expect(inputAudioCodec).toBe('aac');

    const { stdout } = await runCli([
      '--flow',
      flowPath(),
      '--file',
      mediaPath,
      '--work-dir',
      workDir,
    ]);
    expect(stdout).toContain('Stopped: end-of-flow');

    const match = /Result path: (.+)/.exec(stdout);
    const produced = match?.[1]?.trim();
    expect(produced).toBeDefined();
    // The engine never implicitly replaces a file: the result is a new path.
    expect(produced).not.toBe(mediaPath);
    expect(produced).toBe(join(workDir, 'sample.mkv'));
    expect(statSync(produced!).size).toBeGreaterThan(0);
    // The input survived untouched.
    expect(await videoCodecOf(mediaPath)).toBe('h264');

    expect(await videoCodecOf(produced!)).toBe('hevc');

    // Regression guard: the flow only touched the video encoder. The audio
    // stream was never asked to encode, so it must come out of the OUTPUT
    // exactly as it went into the input (aac) rather than falling through to
    // ffmpeg's container default (which, for Matroska, is vorbis) — that
    // fallthrough was a real, silent data-quality bug where untouched streams
    // got re-encoded.
    expect(await audioCodecOf(produced!)).toBe(inputAudioCodec);
    expect(await audioCodecOf(produced!)).toBe('aac');
  }, 180_000);

  it('routes to the already-correct branch on a second pass, doing no work', async () => {
    // Convergence in miniature: a file that already matches ends the flow at
    // the check node instead of transcoding. The converged fixture is built in
    // beforeAll, not inherited from the transcode test's output — depending on
    // another test's side effects makes an upstream failure look like a bug
    // here, and couples the two to their execution order.
    expect(await videoCodecOf(convergedPath)).toBe('hevc');
    const { stdout } = await runCli([
      '--flow',
      flowPath(),
      '--file',
      convergedPath,
      '--work-dir',
      workDir,
      '--dry-run',
    ]);
    expect(stdout).toContain('1. Start');
    expect(stdout).not.toContain('Would run:');
  }, 60_000);
});
