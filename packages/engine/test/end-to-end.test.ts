import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { beginFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import { toolAvailableSync } from '../../../test-support/tool-availability.js';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';

const execFileAsync = promisify(execFile);

// describe.runIf's condition is read at collection time, before any
// beforeAll runs — so the ffmpeg check must be synchronous and done at
// module scope. An async check gated behind beforeAll would always read as
// unavailable and skip the whole suite regardless of whether ffmpeg exists.
// See `toolAvailableSync`: only ENOENT means "not installed" and skips;
// a check that could not be trusted throws instead of skipping silently.
const available = toolAvailableSync('ffmpeg');
let workDir: string;
let sourceDir: string;
let mediaPath: string;
let convergedPath: string;
let coverFirstPath: string;
let degenerateCoverPath: string;

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

/**
 * A file whose first stream is a single-frame mjpeg still — the shape cover art
 * takes — followed by the real video and its audio. Built by muxing a generated
 * still ahead of the sample so the ORDER is real, which is the whole point:
 * output-stream ordering is what decides whether a type-specifier codec flag
 * collides with an earlier stream's copy directive.
 */
const makeCoverFirstSample = async (path: string, stillPath: string) => {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x120:d=0.04:r=25',
    '-frames:v',
    '1',
    stillPath,
  ]);
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i',
    stillPath,
    '-i',
    mediaPath,
    '-map',
    '0:v:0',
    '-map',
    '1:v:0',
    '-map',
    '1:a:0',
    '-c:v:0',
    'mjpeg',
    '-c:v:1',
    'copy',
    '-c:a',
    'copy',
    '-disposition:v:0',
    'attached_pic',
    path,
  ]);
};

/**
 * A file shaped like the ones that broke a real 5.5 TB library: real video,
 * real audio, a genuine cover-art poster, and a DEGENERATE cover-art stream
 * that probes as 0x0.
 *
 * The degenerate stream is manufactured the way the real ones are broken,
 * because no muxer will write one directly: mux a real still, then set the
 * track's Matroska `PixelWidth` (0xB0) and `PixelHeight` (0xBA) elements to
 * zero and destroy the JPEG payload, so the decoder cannot recover the
 * dimensions from the frame either — which is exactly what real files with
 * `[mjpeg] bits NNN is invalid` do. The EBML element lengths are preserved,
 * so the container stays valid and every other stream is untouched.
 *
 * The caller asserts what ffprobe says about the result, so if this technique
 * ever stops producing a 0x0 stream the test fails loudly rather than passing
 * over a fixture that no longer contains the bug.
 */
const makeDegenerateCoverArtSample = async (input: {
  path: string;
  posterPath: string;
  degeneratePath: string;
}) => {
  const still = (path: string, size: string, colour: string) =>
    execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${colour}:s=${size}:d=0.04:r=25`,
      '-frames:v',
      '1',
      path,
    ]);

  await still(input.posterPath, '120x160', 'red');
  await still(input.degeneratePath, '64x64', 'blue');
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i',
    mediaPath,
    '-i',
    input.posterPath,
    '-i',
    input.degeneratePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-map',
    '1:v:0',
    '-map',
    '2:v:0',
    '-c',
    'copy',
    input.path,
  ]);

  const file = readFileSync(input.path);
  // 64 = 0x40, written as a one-byte EBML unsigned int: `B0 81 40`. Searched
  // only in the header region, where the Tracks element lives, and required
  // to be unique — a stray match in frame data would corrupt the wrong bytes.
  const header = file.subarray(0, 4096);
  const patched = Buffer.from(file);
  for (const element of [0xb0, 0xba]) {
    const pattern = Buffer.from([element, 0x81, 0x40]);
    const at = header.indexOf(pattern);
    expect(at).toBeGreaterThan(-1);
    expect(header.indexOf(pattern, at + 1)).toBe(-1);
    patched[at + 2] = 0x00;
  }
  const frame = readFileSync(input.degeneratePath);
  const frameAt = patched.indexOf(frame);
  expect(frameAt).toBeGreaterThan(-1);
  patched.fill(0x00, frameAt + 2, frameAt + frame.length);
  writeFileSync(input.path, patched);
};

/** The subset of an ffprobe stream these tests read back off a real file. */
interface ProbedStream {
  index: number;
  codec_name: string;
  codec_type: string;
  disposition?: Record<string, number>;
  // Open, like ProbeStream itself, so a probed stream can be handed straight
  // to beginFfmpegCommand without being retyped.
  [key: string]: unknown;
}

const streamsOf = async (path: string): Promise<ProbedStream[]> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-of',
    'json',
    path,
  ]);
  return (JSON.parse(stdout) as { streams: ProbedStream[] }).streams;
};

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

  coverFirstPath = join(sourceDir, 'cover-first.mkv');
  await makeCoverFirstSample(coverFirstPath, join(sourceDir, 'cover.png'));

  degenerateCoverPath = join(sourceDir, 'degenerate-cover.mkv');
  await makeDegenerateCoverArtSample({
    path: degenerateCoverPath,
    posterPath: join(sourceDir, 'poster.jpg'),
    degeneratePath: join(sourceDir, 'degenerate.jpg'),
  });
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
    // `-c:0`, not `-c:v`: codecs are addressed by resolved output index, so a
    // type specifier can never reach a stream it was not meant for.
    expect(stdout).toContain('-c:0 libx265');
    expect(stdout).not.toContain('-c:v');
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

  /**
   * The destructive chain, through the real CLI: transcode, verify, replace.
   *
   * Its first job is to prove the live path SUBSTITUTES the two engine-
   * controlled nodes at all. Their declared `plugin()` bodies throw on
   * purpose, so before the runners were wired into the CLI a flow containing
   * either node did not merely misbehave — it could not run. A unit test of a
   * runner cannot catch that; only driving the flow the way a user does can.
   *
   * It works on its own copy of a sample rather than the shared fixtures,
   * because unlike every other test here this one deliberately destroys its
   * input.
   */
  it('verifies the transcode and replaces the original, keeping it in trash', async () => {
    const replaceDir = mkdtempSync(join(tmpdir(), 'trawlarr-replace-e2e-'));
    const replaceWorkDir = join(replaceDir, 'work');
    mkdirSync(replaceWorkDir, { recursive: true });
    const originalPath = join(replaceDir, 'to-replace.mkv');
    await makeSample(originalPath, 'libx264');
    expect(await videoCodecOf(originalPath)).toBe('h264');
    const originalSize = statSync(originalPath).size;

    const flow = join(replaceDir, 'flow.json');
    writeFileSync(
      flow,
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
          {
            id: 'verify',
            pluginId: 'trawlarr:verifyOutput',
            pluginVersion: '1.0.0',
            inputs: { durationToleranceSeconds: '1', minSizeRatio: '0.05' },
          },
          {
            id: 'replace',
            pluginId: 'trawlarr:replaceOriginal',
            pluginVersion: '1.0.0',
            inputs: { trashRetentionDays: '14', allowCrossDevice: 'true' },
          },
        ],
        edges: [
          { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
          { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
          { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'encoder' },
          { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'execute' },
          { fromNodeId: 'execute', outputNumber: 1, toNodeId: 'verify' },
          { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
        ],
      }),
      'utf8',
    );

    const { stdout } = await runCli([
      '--flow',
      flow,
      '--file',
      originalPath,
      '--work-dir',
      replaceWorkDir,
    ]);

    expect(stdout).toContain('Stopped: end-of-flow');
    // Both engine-controlled nodes ran and routed to their success output,
    // rather than throwing the "must be run by the trawlarr engine" error.
    expect(stdout).toContain('Verify Output → output 1');
    expect(stdout).toContain('Replace Original File → output 1');
    expect(stdout).toContain(`Result path: ${originalPath}`);

    // The library path now holds the TRANSCODE.
    expect(await videoCodecOf(originalPath)).toBe('hevc');

    // And the original is in trash, intact and still h264 — recoverable, not
    // deleted, and inside `.trawlarr`, which library scans prune.
    const trashDir = join(replaceDir, '.trawlarr', 'trash');
    const trashed = readdirSync(trashDir);
    expect(trashed).toHaveLength(1);
    const trashedPath = join(trashDir, trashed[0]!);
    expect(await videoCodecOf(trashedPath)).toBe('h264');
    expect(statSync(trashedPath).size).toBe(originalSize);
  }, 180_000);
});

/**
 * Every other test in this suite, and every unit test behind it, checks the
 * CONTRACT level: which argument strings we emit. This one checks the level
 * below — what those strings MEAN to ffmpeg — because a codec flag can be
 * spelled perfectly and still address the wrong stream.
 */
describe.runIf(available)('compiled argv, as real ffmpeg reads it', () => {
  /** True for a flag that selects a codec for a whole stream TYPE. */
  const isTypeSpecifierCodecFlag = (arg: string): boolean =>
    /^-(c|codec):[vasdt]$/.test(arg) || /^-[vasd]codec(:|$)/.test(arg);

  it('encodes the video while leaving cover art that precedes it untouched', async () => {
    // The fixture really is ordered still-image first, video second.
    const sourceStreams = await streamsOf(coverFirstPath);
    expect(sourceStreams.map((stream) => stream.codec_name)).toEqual(['mjpeg', 'h264', 'aac']);

    // The attached_pic disposition is set on the probe here rather than read
    // back off the file, and that is a deliberate, documented compromise: no
    // container ffmpeg 6.1.1 can WRITE yields a file where ffprobe reports
    // cover art before the video. Matroska drops the disposition on muxing,
    // and mp4/mov store cover art in a udta/meta `covr` atom, which the
    // demuxer always surfaces as the LAST stream. So the ORDER is real (it
    // comes from the file), and the disposition is injected to describe the
    // file as a probe of real-world cover-art-first media would.
    const probe: ProbeData = {
      streams: sourceStreams.map((stream, position) =>
        position === 0
          ? { ...stream, disposition: { ...stream.disposition, attached_pic: 1 } }
          : stream,
      ),
    };

    const command = beginFfmpegCommand({
      probe,
      container: 'mkv',
      inputPath: coverFirstPath,
    });
    // Cover art is reclassified, so the encoder node will skip it and the
    // compiler will hand it a copy directive.
    expect(command.streams[0]!.codec_type).toBe('attachment');

    const out = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin({
      inputFileObj: { _id: coverFirstPath, container: 'mkv', ffProbeData: probe },
      variables: { ffmpegCommand: command, flowFailed: false, user: {} },
      inputs: { encoder: 'libx265', quality: '30' },
      jobLog: () => {},
    } as unknown as PluginInputArgs);

    const producedPath = join(workDir, 'cover-first-encoded.mkv');
    const argv = compileFfmpegArgs({
      command: out.variables.ffmpegCommand,
      outputPath: producedPath,
    });

    await execFileAsync('ffmpeg', ['-hide_banner', '-y', ...argv]);

    // The load-bearing assertion, and deliberately made BEFORE the argv check
    // below: the video was encoded and the cover art was not. It is what real
    // ffmpeg did, not what we believe we asked for.
    const producedStreams = await streamsOf(producedPath);
    expect(producedStreams.map((stream) => stream.codec_name)).toEqual(['mjpeg', 'hevc', 'aac']);

    // And the reason, stated at the contract level so a regression names its
    // own cause: ffmpeg resolves `-c` by LAST matching specifier, so a type
    // specifier reaches every stream of that type — including cover art, a
    // video-typed output stream however we classify it internally. Addressing
    // codecs by output index is the only form that cannot collide.
    expect(argv.filter(isTypeSpecifierCodecFlag)).toEqual([]);
  }, 120_000);

  /**
   * The dimensionless-cover-art bug, end to end on a real file.
   *
   * Argument-level tests can only say which strings we emit; this says what
   * ffmpeg DOES with them, which is the level the previous cover-art data-loss
   * bug hid at. It asserts both directions on the produced file: the
   * degenerate stream is gone, and the genuine poster came through with its
   * codec and its exact dimensions intact.
   */
  it('drops a dimensionless cover-art stream while the real poster survives untouched', async () => {
    const sourceStreams = await streamsOf(degenerateCoverPath);
    // The fixture really contains the bug: a valid 120x160 poster and a
    // degenerate stream ffprobe reports as 0x0, in one real file.
    expect(sourceStreams.map((stream) => [stream.codec_name, stream.width, stream.height])).toEqual(
      [
        ['h264', 320, 240],
        ['aac', undefined, undefined],
        ['mjpeg', 120, 160],
        ['mjpeg', 0, 0],
      ],
    );

    const probe: ProbeData = {
      // Same documented compromise as the test above: Matroska drops the
      // attached_pic disposition on muxing, so it is injected here to
      // describe the file as a probe of real cover-art media would. The
      // DIMENSIONS — the thing under test — are the file's own.
      streams: sourceStreams.map((stream) =>
        stream.codec_name === 'mjpeg'
          ? { ...stream, disposition: { ...stream.disposition, attached_pic: 1 } }
          : stream,
      ),
    };

    const command = beginFfmpegCommand({
      probe,
      container: 'mkv',
      inputPath: degenerateCoverPath,
    });
    const out = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin({
      inputFileObj: { _id: degenerateCoverPath, container: 'mkv', ffProbeData: probe },
      variables: { ffmpegCommand: command, flowFailed: false, user: {} },
      inputs: { encoder: 'libx265', quality: '30' },
      jobLog: () => {},
    } as unknown as PluginInputArgs);

    const dropped: { index: number; codecName: string; reason: string }[] = [];
    const producedPath = join(workDir, 'degenerate-cover-encoded.mkv');
    const argv = compileFfmpegArgs({
      command: out.variables.ffmpegCommand,
      outputPath: producedPath,
      onDroppedStream: (entry) => dropped.push(entry),
    });

    // Exactly one stream dropped, named so the job log can say which.
    expect(dropped).toEqual([
      { index: 3, codecName: 'mjpeg', reason: expect.stringContaining('dimensions 0x0') },
    ]);

    // The bug is real on THIS file, not a hypothesis: the same command with
    // the degenerate stream mapped back in — which is what mapping every
    // input stream produced — fails to mux at all.
    const withDegenerate = [
      ...argv.slice(0, -1),
      '-map',
      '0:3',
      `-c:${String(argv.filter((_, i) => argv[i - 1] === '-map').length)}`,
      'copy',
      join(workDir, 'degenerate-cover-all-streams.mkv'),
    ];
    const failure = await execFileAsync('ffmpeg', ['-hide_banner', '-y', ...withDegenerate]).then(
      () => null,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure).not.toBeNull();
    expect(failure!.code).not.toBe(0);
    expect(failure!.stderr).toContain('dimensions not set');

    // And the command we actually build runs.
    await execFileAsync('ffmpeg', ['-hide_banner', '-y', ...argv]);

    // The load-bearing assertions, made on the OUTPUT FILE: the degenerate
    // stream is gone, the video was encoded, and the genuine poster survived
    // with its codec and its exact dimensions — copied, not re-encoded to
    // some other size or codec. Dropping cover art instead of the broken
    // stream would destroy artwork in every file this touches, which is
    // worse than the bug being fixed.
    const producedStreams = await streamsOf(producedPath);
    expect(
      producedStreams.map((stream) => [stream.codec_name, stream.width, stream.height]),
    ).toEqual([
      ['hevc', 320, 240],
      ['aac', undefined, undefined],
      ['mjpeg', 120, 160],
    ]);
    // The poster is byte-for-byte the frame that went in, not a re-encode.
    const posterOut = join(workDir, 'poster-out.jpg');
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i',
      producedPath,
      '-map',
      '0:2',
      '-c',
      'copy',
      '-f',
      'mjpeg',
      posterOut,
    ]);
    expect(readFileSync(posterOut).equals(readFileSync(join(sourceDir, 'poster.jpg')))).toBe(true);
  }, 180_000);
});
