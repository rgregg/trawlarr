import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PluginFileObject, PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { beginFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import { createPluginLoader } from '../../src/host/loader.js';
import { toPluginFileObject } from '../../src/host/file-object.js';
import { toolAvailableSync } from '../../../../test-support/tool-availability.js';
import { corpusAvailable, pluginPath } from './corpus.js';

const execFileAsync = promisify(execFile);

// Synchronous at module scope: describe.runIf is evaluated at collection time,
// so a condition computed inside beforeAll always reads false and skips the
// suite silently. toolAvailableSync answers false only for ENOENT.
const available = toolAvailableSync('ffmpeg') && toolAvailableSync('ffprobe') && corpusAvailable();

let workDir = '';
let sourcePath = '';

/**
 * A real file tagged the way real libraries are tagged, rather than the way
 * plugins assume they are.
 *
 * Audio tracks, in order:
 *  0. `English` — the literal string six *Ally McBeal* files in the owner's
 *     library carry instead of `eng`.
 *  1. `en` — ISO 639-1, which no exact OR substring match against `eng` finds.
 *  2. `deu` — ISO 639-2/T, where the keep-list is written in 639-2/B (`ger`).
 *  3. `jpn` — a genuinely foreign track that MUST still be removed. Without
 *     this every assertion here could be satisfied by a filter that gave up.
 *  4. no language tag at all — never judged, always kept.
 *
 * A fifth track tagged `und` is deliberately absent: Matroska treats `und` as
 * its default and ffmpeg writes no Language element for it, so on disk it is
 * indistinguishable from track 4. `und` is pinned at the probe boundary
 * instead, in packages/core/src/language-tag.test.ts and
 * packages/engine/src/host/file-object.test.ts.
 */
const makeSample = async (path: string) => {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=160x120:rate=10',
    ...['440', '460', '480', '500', '520'].flatMap((frequency) => [
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:duration=1`,
    ]),
    '-map',
    '0:v',
    ...[1, 2, 3, 4, 5].flatMap((input) => ['-map', `${String(input)}:a`]),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-metadata:s:a:0',
    'language=English',
    '-metadata:s:a:1',
    'language=en',
    '-metadata:s:a:2',
    'language=deu',
    '-metadata:s:a:3',
    'language=jpn',
    // The fifth audio track deliberately gets no language metadata.
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

const audioLanguagesIn = async (path: string): Promise<(string | null)[]> =>
  ((await probeOf(path)).streams ?? [])
    .filter((s) => s.codec_type === 'audio')
    .map((s) => s.tags?.language ?? null);

/**
 * The REAL host projection — this is the whole point of the suite. A test that
 * hand-built `inputFileObj` (as the neighbouring parity suite does, because it
 * is testing other things) would bypass the boundary being exercised here.
 */
const fileObjectFor = (probe: ProbeData): PluginFileObject =>
  toPluginFileObject({
    fileId: 'f1',
    libraryId: 'lib1',
    footprintId: '2049:42',
    path: sourcePath,
    container: 'mkv',
    sizeBytes: 1_000_000,
    originalSizeBytes: 1_000_000,
    mtimeMs: 1_700_000_000_000,
    ctimeMs: 1_700_000_000_000,
    probe,
    state: 'unknown',
    lastRunModified: false,
    holdUntilMs: null,
    lastTranscodeMs: null,
    lastHealthCheckMs: null,
    history: '',
    discoveredAtMs: 1_690_000_000_000,
  });

/**
 * Runs the vendored community filter exactly as a job does: probe → host
 * projection → Begin Command (which seeds itself from `ffProbeData`) → the
 * third-party plugin → the compiler → real ffmpeg.
 */
const filterThroughFfmpeg = async (input: {
  inputs: Record<string, unknown>;
  outputName: string;
}) => {
  const abs = pluginPath('ffmpegCommand/ffmpegCommandRemoveStreamByProperty/1.0.0/index.js');
  expect(existsSync(abs)).toBe(true);

  const file = fileObjectFor(await probeOf(sourcePath));
  const args = {
    inputFileObj: file,
    originalLibraryFile: file,
    inputs: input.inputs,
    variables: {
      // Exactly what `plugins-core/src/beginCommand` does, from exactly the
      // object the host handed the plugin.
      ffmpegCommand: beginFfmpegCommand({
        probe: file.ffProbeData,
        container: file.container,
        inputPath: sourcePath,
      }),
      flowFailed: false,
      user: {},
    },
    jobLog: () => {},
    updateWorker: () => {},
    deps: {},
  } as unknown as PluginInputArgs;

  const loaded = createPluginLoader().load(abs);
  const output = await loaded.module.plugin(args);
  const outputPath = join(workDir, input.outputName);
  const argv = compileFfmpegArgs({ command: output.variables.ffmpegCommand, outputPath });
  await execFileAsync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...argv], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { outputPath, command: output.variables.ffmpegCommand };
};

beforeAll(async () => {
  if (!available) return;
  workDir = mkdtempSync(join(tmpdir(), 'trawlarr-langtag-'));
  mkdirSync(join(workDir, 'source'), { recursive: true });
  sourcePath = join(workDir, 'source', 'Sample.mkv');
  await makeSample(sourcePath);
}, 180_000);

describe.runIf(available)('the generated fixture', () => {
  it('really carries the non-ISO tags every assertion below depends on', async () => {
    expect(await audioLanguagesIn(sourcePath)).toEqual(['English', 'en', 'deu', 'jpn', null]);
  }, 60_000);
});

describe.runIf(available)('a keep-list applied to non-ISO language tags', () => {
  it('keeps English tagged any way at all, and still removes the Japanese track', async () => {
    const { outputPath } = await filterThroughFfmpeg({
      inputs: {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng,ger',
        condition: 'not_includes',
      },
      outputName: 'keep-eng-ger.mkv',
    });

    // `en` and `deu` are the two this fails on without normalisation: neither
    // contains `eng` or `ger` as a substring, so both were removed as foreign.
    // `English` survived only by the accident that it CONTAINS `eng` — which
    // is exactly why the substring rule cannot be relied on.
    //
    // And the tags in the OUTPUT are still the file's own: normalising what a
    // plugin sees never rewrites what is on disk.
    expect(await audioLanguagesIn(outputPath)).toEqual(['English', 'en', 'deu', null]);
  }, 120_000);

  it('does the same under an exact-match condition, which is what Tdarr’s classic plugins use', async () => {
    // `Tdarr_Plugin_MC93_Migz3CleanAudio.js:136` compares with
    // `language.indexOf(tag.toLowerCase()) === -1` — no substring escape
    // hatch. Under that rule `English` is as foreign as `jpn`, and every audio
    // track in this file matched for removal. The host's all-audio guard then
    // refused the whole removal, so the file kept its Japanese track too and
    // could never converge. This is the case the guard could not fix.
    const { outputPath } = await filterThroughFfmpeg({
      inputs: {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_equals',
      },
      outputName: 'keep-eng-exact.mkv',
    });

    expect(await audioLanguagesIn(outputPath)).toEqual(['English', 'en', null]);
  }, 120_000);

  it('still removes what the keep-list really excludes — it does not just keep everything', async () => {
    // A German keep-list, exactly matched. `deu` is folded onto `ger` and
    // survives; the English tracks are correctly judged foreign and go. A
    // normalisation that erred towards keeping tracks would fail here, and
    // failing here is how we know the two tests above are not vacuous.
    const { command, outputPath } = await filterThroughFfmpeg({
      inputs: {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'ger',
        condition: 'not_equals',
      },
      outputName: 'keep-ger-exact.mkv',
    });

    // What the plugin saw: canonical ISO 639-2/B, in the command it built.
    const audio = command.streams.filter((s) => s.codec_type === 'audio');
    expect(audio.map((s) => [s.tags?.language ?? null, s.removed])).toEqual([
      ['eng', true],
      ['eng', true],
      ['ger', false],
      ['jpn', true],
      [null, false],
    ]);
    // What is on disk afterwards: the file's own tag, unrewritten.
    expect(await audioLanguagesIn(outputPath)).toEqual(['deu', null]);
  }, 120_000);
});
