import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { beginFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import { createPluginLoader } from '../../src/host/loader.js';
import { toolAvailableSync } from '../../../../test-support/tool-availability.js';
import { corpusAvailable, pluginPath } from './corpus.js';

const execFileAsync = promisify(execFile);

// Both conditions are computed SYNCHRONOUSLY at module scope: describe.runIf
// is evaluated at collection time, before any async beforeAll, so a condition
// set inside beforeAll always reads false and silently skips the whole suite.
// toolAvailableSync answers false ONLY for ENOENT and throws otherwise, so a
// check that could not be trusted fails the run rather than skipping it green.
const available = toolAvailableSync('ffmpeg') && toolAvailableSync('ffprobe') && corpusAvailable();

let workDir = '';
let sourcePath = '';

/**
 * A real multi-track file: cover art, video, English 5.1, Japanese stereo, and
 * one untagged mono audio track. Generated rather than committed, so nothing
 * binary lands in the repository.
 */
const makeSample = async (path: string, coverPath: string) => {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x120:d=0.04:r=25',
    '-frames:v',
    '1',
    coverPath,
  ]);
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i',
    coverPath,
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=2',
    '-map',
    '0:v:0',
    '-map',
    '1:v:0',
    '-map',
    '2:a:0',
    '-map',
    '3:a:0',
    '-map',
    '4:a:0',
    '-c:v:0',
    'mjpeg',
    '-disposition:v:0',
    'attached_pic',
    '-c:v:1',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    // Real channel counts, not the mono `sine` default: English 5.1, Japanese
    // stereo, untagged mono. Without this every track is 1-channel and
    // "Ensure Audio Stream" clamps its target to 1, so the channel-layout
    // assertions below would pass having proved nothing about downmixing.
    '-ac:a:0',
    '6',
    '-ac:a:1',
    '2',
    '-metadata:s:a:0',
    'language=eng',
    '-metadata:s:a:1',
    'language=jpn',
    // The third audio track deliberately gets NO language metadata.
    path,
  ]);
};

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

const streamSummary = async (path: string) => {
  const probe = await probeOf(path);
  return (probe.streams ?? []).map((s) => ({
    codec_type: s.codec_type,
    codec_name: s.codec_name,
    channels: s.channels ?? null,
    language: (s.tags as Record<string, string> | undefined)?.language ?? null,
  }));
};

/**
 * md5 of one stream's ENCODED packets, ignoring container framing. This is
 * what makes "a remux must never re-encode" an assertion about bytes rather
 * than about a codec name: a re-encode to h264 would still be called h264.
 */
const streamPayloadMd5 = async (path: string, specifier: string): Promise<string> => {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-i',
    path,
    '-map',
    specifier,
    '-c',
    'copy',
    '-f',
    'md5',
    '-',
  ]);
  const digest = stdout.trim();
  // Fail loudly rather than comparing two empty strings: a mapping that
  // selected nothing would otherwise make the comparison below trivially true.
  expect(digest).toMatch(/^MD5=[0-9a-f]{32}$/);
  return digest;
};

beforeAll(async () => {
  if (!available) return;
  workDir = mkdtempSync(join(tmpdir(), 'trawlarr-parity-'));
  mkdirSync(join(workDir, 'source'), { recursive: true });
  sourcePath = join(workDir, 'source', 'Sample.mkv');
  await makeSample(sourcePath, join(workDir, 'source', 'cover.png'));
}, 180_000);

const argsFor = (input: {
  inputs: Record<string, unknown>;
  probe: ProbeData;
  container: string;
}): PluginInputArgs =>
  ({
    inputFileObj: { _id: sourcePath, container: input.container, ffProbeData: input.probe },
    originalLibraryFile: { _id: sourcePath, container: input.container },
    inputs: input.inputs,
    variables: {
      ffmpegCommand: beginFfmpegCommand({
        probe: input.probe,
        container: input.container,
        inputPath: sourcePath,
      }),
      flowFailed: false,
      user: {},
    },
    jobLog: () => {},
    updateWorker: () => {},
    // Only webRequest reaches deps in this suite, and it is not exercised here.
    deps: {},
  }) as unknown as PluginInputArgs;

const runThroughFfmpeg = async (input: {
  rel: string;
  inputs: Record<string, unknown>;
  outputName: string;
}) => {
  const abs = pluginPath(input.rel);
  expect(existsSync(abs)).toBe(true);
  const probe = await probeOf(sourcePath);
  const loaded = createPluginLoader().load(abs);
  const args = argsFor({ inputs: input.inputs, probe, container: 'mkv' });
  const output = await loaded.module.plugin(args);
  const command = output.variables.ffmpegCommand;
  const outputPath = join(workDir, input.outputName);
  const argv = compileFfmpegArgs({ command, outputPath });
  await execFileAsync('ffmpeg', ['-hide_banner', '-y', ...argv], { maxBuffer: 10 * 1024 * 1024 });
  return { outputPath, command, argv };
};

describe.runIf(available)('the generated fixture', () => {
  it('really has the six-way shape every assertion below depends on', async () => {
    // Guards against silent coverage loss: if a future ffmpeg build changed
    // what this command produces, the assertions below could pass having
    // exercised a file with nothing to remove and nothing to preserve.
    const summary = await streamSummary(sourcePath);
    expect(summary.filter((s) => s.codec_type === 'video').map((s) => s.codec_name)).toEqual([
      'mjpeg',
      'h264',
    ]);
    expect(summary.filter((s) => s.codec_type === 'audio').map((s) => s.language)).toEqual([
      'eng',
      'jpn',
      null,
    ]);
    expect(summary.filter((s) => s.codec_type === 'audio').map((s) => s.channels)).toEqual([
      6, 2, 1,
    ]);
  }, 60_000);
});

describe.runIf(available)('Set Container against real ffmpeg', () => {
  it('remuxes mkv to mp4 and the result really is mp4, with the video bit-identical', async () => {
    const before = await streamSummary(sourcePath);
    expect(before.filter((s) => s.codec_type === 'video')).toHaveLength(2);

    const { outputPath } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
      inputs: { container: 'mp4', forceConform: true },
      outputName: 'remuxed.mp4',
    });

    const probe = await probeOf(outputPath);
    // ffprobe names the mp4 family "mov,mp4,m4a,3gp,3g2,mj2".
    expect(String(probe.format?.format_name)).toContain('mp4');
    const video = (probe.streams ?? []).filter((s) => s.codec_type === 'video');
    // The real video track survived as h264 — a remux must never re-encode.
    expect(video.some((s) => s.codec_name === 'h264')).toBe(true);
    // And every audio track came across untouched, still aac, still at its
    // original channel count.
    const audio = (probe.streams ?? []).filter((s) => s.codec_type === 'audio');
    expect(audio.map((s) => s.codec_name)).toEqual(['aac', 'aac', 'aac']);
    expect(audio.map((s) => s.channels)).toEqual([6, 2, 1]);

    // Bit-identical, asserted on BYTES: the encoded h264 packets in the mp4
    // hash the same as the ones in the source mkv. A silent re-encode would
    // still report codec_name 'h264' and pass every check above. Stream order
    // is preserved across the remux, so the real video is 0:v:1 in both and
    // the cover art is 0:v:0 in both.
    expect(await streamPayloadMd5(outputPath, '0:v:1')).toBe(
      await streamPayloadMd5(sourcePath, '0:v:1'),
    );
    // The cover art came across byte-for-byte too — the data-loss bug this
    // repo shipped, asserted on the poster's actual pixels rather than on the
    // argv that was meant to preserve them.
    expect(await streamPayloadMd5(outputPath, '0:v:0')).toBe(
      await streamPayloadMd5(sourcePath, '0:v:0'),
    );
  }, 120_000);
});

describe.runIf(available)('Remove Stream By Property against real ffmpeg', () => {
  it('drops the Japanese track, keeps English, keeps the untagged track and the cover art', async () => {
    const { outputPath } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandRemoveStreamByProperty/1.0.0/index.js',
      inputs: {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      outputName: 'filtered.mkv',
    });

    const after = await streamSummary(outputPath);
    const audio = after.filter((s) => s.codec_type === 'audio');
    // English survives; Japanese is gone; the untagged track survives because
    // the plugin never judges a stream whose property is absent. This is the
    // assertion that stands in for Unmanic's `keep_undefined`.
    expect(audio.map((s) => s.language)).toEqual(['eng', null]);
    // The cover art is still there, still mjpeg. This is the cover-art
    // data-loss bug seen from the removal side: an implementation that
    // addressed streams by type specifier would have taken it.
    expect(after.filter((s) => s.codec_name === 'mjpeg')).toHaveLength(1);
    // And the real video is untouched.
    expect(after.filter((s) => s.codec_name === 'h264')).toHaveLength(1);
  }, 120_000);

  it('produces an output with FEWER streams than the original — the fact Task 3 depends on', async () => {
    const { outputPath } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandRemoveStreamByProperty/1.0.0/index.js',
      inputs: {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      outputName: 'filtered-count.mkv',
    });
    const originalCount = (await streamSummary(sourcePath)).length;
    const outputCount = (await streamSummary(outputPath)).length;
    expect(originalCount).toBe(5);
    expect(outputCount).toBe(4);
    expect(outputCount).toBeLessThan(originalCount);
  }, 120_000);
});

describe.runIf(available)('Ensure Audio Stream against real ffmpeg', () => {
  it('adds a real ac3 track alongside the originals, encoding only that one stream', async () => {
    const before = (await streamSummary(sourcePath)).filter((s) => s.codec_type === 'audio');

    const { outputPath, argv } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandEnsureAudioStream/1.0.0/index.js',
      inputs: { audioEncoder: 'ac3', language: 'eng', channels: 6 },
      outputName: 'ensured.mkv',
    });

    // The placeholders the plugin writes must never reach ffmpeg literally.
    expect(argv.join(' ')).not.toContain('{outputIndex}');
    expect(argv.join(' ')).not.toContain('{outputTypeIndex}');
    // Codec flags are addressed by OUTPUT INDEX, never by type specifier:
    // `-c:v` would also match cover art reclassified as an attachment. This
    // is the proven data-loss bug, asserted on the emitted argv.
    expect(argv.filter((a) => /^-c:[vasd]$/.test(a))).toEqual([]);

    const after = (await streamSummary(outputPath)).filter((s) => s.codec_type === 'audio');
    expect(after.length).toBe(before.length + 1);
    // The added track really is the codec AND the channel layout that were
    // asked for, on disk — not merely an argument that was emitted.
    expect(after.filter((s) => s.codec_name === 'ac3')).toEqual([
      { codec_type: 'audio', codec_name: 'ac3', channels: 6, language: 'eng' },
    ]);
    // And every original audio track is still present, still aac, and still
    // at its ORIGINAL channel count: the plugin emits a bare `-ac` with no
    // stream specifier, so this is what proves the compiler's explicit
    // per-output-index `-c:<n> copy` keeps that from bleeding across streams
    // and silently remixing the whole file.
    const originals = after.filter((s) => s.codec_name === 'aac');
    expect(originals).toHaveLength(before.length);
    expect(originals.map((s) => s.channels)).toEqual(before.map((s) => s.channels));

    // The video streams were not collateral damage of the one audio encode:
    // the cover art is still mjpeg and the video is still h264, byte-copied.
    const all = await streamSummary(outputPath);
    expect(all.filter((s) => s.codec_name === 'mjpeg')).toHaveLength(1);
    expect(all.filter((s) => s.codec_name === 'h264')).toHaveLength(1);
  }, 180_000);

  it('performs the owner\'s "ensure 2ch AAC" as a real stereo downmix on disk', async () => {
    // His Unmanic pipeline ends in a 2-channel AAC track. The source English
    // track is 5.1, so a genuine downmix has to happen — asking for something
    // the file already has would add nothing and prove nothing.
    const { outputPath } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandEnsureAudioStream/1.0.0/index.js',
      inputs: { audioEncoder: 'aac', language: 'eng', channels: 2 },
      outputName: 'stereo.mkv',
    });

    const audio = (await streamSummary(outputPath)).filter((s) => s.codec_type === 'audio');
    // Four tracks now: the original 5.1 eng, stereo jpn, mono untagged, plus
    // the new stereo eng downmix. Note the Tdarr semantic — it ADDS the
    // stereo track rather than replacing the 5.1 one, which is where Unmanic
    // parity is behavioural rather than literal.
    expect(audio.map((s) => [s.codec_name, s.channels, s.language])).toEqual([
      ['aac', 6, 'eng'],
      ['aac', 2, 'jpn'],
      ['aac', 1, null],
      ['aac', 2, 'eng'],
    ]);
  }, 180_000);
});

describe.runIf(available)('Custom Arguments against real ffmpeg', () => {
  it("carries the owner's -max_muxing_queue_size 2048 into a real invocation that succeeds", async () => {
    const { outputPath, argv } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandCustomArguments/1.0.0/index.js',
      inputs: { inputArguments: '', outputArguments: '-max_muxing_queue_size 2048' },
      outputName: 'custom-args.mkv',
    });
    expect(argv.slice(-3)).toEqual(['-max_muxing_queue_size', '2048', outputPath]);
    // ffmpeg accepted the flag and wrote a file with every stream intact.
    expect(await streamSummary(outputPath)).toEqual(await streamSummary(sourcePath));
  }, 120_000);
});
