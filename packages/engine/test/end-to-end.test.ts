import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
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
let mediaPath: string;

beforeAll(async () => {
  if (!available) return;

  workDir = mkdtempSync(join(tmpdir(), 'trawlarr-e2e-'));
  mediaPath = join(workDir, 'sample.mkv');

  // Generate a tiny h264 sample rather than committing a binary fixture.
  await execFileAsync('ffmpeg', [
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
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    mediaPath,
  ]);
}, 60_000);

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
  }, 60_000);

  it('transcodes the sample to hevc for real', async () => {
    const { stdout } = await runCli([
      '--flow',
      flowPath(),
      '--file',
      mediaPath,
      '--work-dir',
      workDir,
    ]);
    expect(stdout).toContain('Stopped: end-of-flow');

    const outputPath = join(workDir, 'sample.mkv');
    const match = /Result path: (.+)/.exec(stdout);
    const produced = match?.[1]?.trim() ?? outputPath;
    expect(statSync(produced).size).toBeGreaterThan(0);

    const { stdout: probeOut } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'csv=p=0',
      produced,
    ]);
    expect(probeOut.trim()).toBe('hevc');
  }, 180_000);

  it('routes to the already-correct branch on a second pass, doing no work', async () => {
    // Convergence in miniature: the transcoded file should now match, so the
    // flow ends at the check node instead of transcoding again.
    const converged = join(workDir, 'sample.mkv');
    const { stdout } = await runCli([
      '--flow',
      flowPath(),
      '--file',
      converged,
      '--work-dir',
      workDir,
      '--dry-run',
    ]);
    expect(stdout).toContain('1. Start');
    expect(stdout).not.toContain('Would run:');
  }, 60_000);
});
