import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { createPluginLoader } from '../../src/host/loader.js';
import { buildPluginDeps } from '../../src/host/deps.js';
import { createCrudTransDbn } from '../../src/host/crud-trans-dbn.js';
import { createAxiosMiddleware } from '../../src/host/axios-middleware.js';
import { toPluginFileObject } from '../../src/host/file-object.js';
import { beginFfmpegCommand, compileFfmpegArgs, emptyFfmpegCommand } from '@trawlarr/core';
import { CORPUS_DIR, corpusAvailable, pluginPath } from './corpus.js';

const available = corpusAvailable();

if (!available) {
  // Deliberately visible rather than a silent skip: CI must not be able to
  // pass this suite by quietly never running it. Locally, this is expected
  // until `pnpm compat:fetch` has been run once.
  console.warn(
    '[compat] Tdarr plugin corpus not found at ' +
      CORPUS_DIR +
      ' — skipping community plugin compatibility tests. Run `pnpm compat:fetch` first.',
  );
}

const probe: ProbeData = {
  format: { duration: '1440.0', bit_rate: '8000000', nb_streams: 3, size: '8000000000' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'eng' } },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
  ],
};

const fileObject = () =>
  toPluginFileObject({
    fileId: 'f1',
    libraryId: 'lib1',
    footprintId: '2049:42',
    path: '/media/movies/Sample.mkv',
    container: 'mkv',
    sizeBytes: 8_000_000_000,
    originalSizeBytes: 8_000_000_000,
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

const documents = new Map<string, Record<string, unknown>>();

const deps = buildPluginDeps({
  configVars: {
    config: {
      nodeID: 'test',
      nodeName: 'test',
      serverURL: '',
      serverIP: '',
      serverPort: '',
      handbrakePath: 'HandBrakeCLI',
      ffmpegPath: 'ffmpeg',
      mkvpropeditPath: 'mkvpropedit',
      pathTranslators: [],
      platform_arch_isdocker: 'linux_x64_false',
      logLevel: 'info',
      processPid: 1,
      priority: 0,
      apiKey: '',
      maxLogSizeMB: 10,
      pollInterval: 1000,
      nodeType: 'mapped',
      unmappedNodeCache: '',
      startPaused: false,
    },
  },
  crudTransDBN: createCrudTransDbn({
    documents: {
      get: (c, d) => documents.get(`${c}::${d}`),
      insert: (c, d, data) => void documents.set(`${c}::${d}`, data),
      update: (c, d, patch) =>
        void documents.set(`${c}::${d}`, { ...(documents.get(`${c}::${d}`) ?? {}), ...patch }),
      removeOne: (c, d) => void documents.delete(`${c}::${d}`),
    },
    hostSettings: { setPauseAllNodes: () => {}, getPauseAllNodes: () => false },
    log: () => {},
    nowMs: () => 1_700_000_000_000,
  }),
  axiosMiddleware: createAxiosMiddleware({ probeFile: async () => probe, log: () => {} }),
});

const argsFor = (inputs: Record<string, unknown>, withCommand: boolean): PluginInputArgs => {
  const file = fileObject();
  return {
    inputFileObj: file,
    originalLibraryFile: file,
    librarySettings: {},
    inputs,
    userVariables: { global: {}, library: {} },
    variables: {
      ffmpegCommand: withCommand
        ? beginFfmpegCommand({ probe, container: 'mkv', inputPath: file._id })
        : emptyFfmpegCommand(),
      flowFailed: false,
      user: {},
    },
    config: {},
    configVars: deps.configVars,
    workDir: '/tmp/trawlarr-compat',
    platform: 'linux',
    arch: 'x64',
    platform_arch_isdocker: 'linux_x64_false',
    ffmpegPath: 'ffmpeg',
    handbrakePath: 'HandBrakeCLI',
    mkvpropeditPath: 'mkvpropedit',
    nodeHardwareType: 'cpu',
    workerType: 'transcode',
    job: {
      version: '1.0.0',
      footprintId: '2049:42',
      jobId: 'j1',
      start: 1_700_000_000_000,
      type: 'transcode',
      fileId: 'f1',
    },
    isAutomation: false,
    logFullCliOutput: false,
    jobLog: () => {},
    updateWorker: () => {},
    logOutcome: () => {},
    updateStat: async () => {},
    installClassicPluginDeps: async () => {
      throw new Error('classic unsupported');
    },
    lastSuccesfulPlugin: null,
    lastSuccessfulRun: null,
    thisPlugin: null,
    deps,
  } as unknown as PluginInputArgs;
};

/**
 * Plugins under test. Chosen to cover the contract's load-bearing surfaces:
 * details() parsing, filter routing, ffmpegCommand mutation, and crudTransDBN.
 * Add to this list whenever a compatibility bug is found — that is how the
 * corpus grows into a regression suite.
 *
 * Paths verified against the fetched corpus on 2026-08-11. The brief's
 * guessed paths were correct for `video/checkVideoCodec`, `file/checkFileSize`,
 * and `tools/processedCheck`. The ffmpegCommand encoder plugin's actual
 * directory is `ffmpegCommandSetVideoEncoder`, not `setVideoEncoder`; its
 * input names (`outputCodec`, `ffmpegPreset`) matched the brief's guess.
 */
const CASES = [
  { rel: 'video/checkVideoCodec/1.0.0/index.js', inputs: { codec: 'hevc' }, command: false },
  {
    rel: 'file/checkFileSize/1.0.0/index.js',
    // The fixture file is 8_000_000_000 bytes = 8000 MB. checkFileSize's own
    // source (CommunityFlowPlugins/file/checkFileSize/1.0.0/index.js:75)
    // computes `fileSizeBytes = args.inputFileObj.file_size * 1000 * 1000`,
    // i.e. it treats `file_size` as MEGABYTES. With a correct MB projection
    // (file_size === 8000), fileSizeBytes === 8e9, which falls inside
    // [7000MB, 9000MB) => output 1. If `file_size` were bytes (the bug this
    // case exists to catch), fileSizeBytes would be 8e9 * 1e6 = 8e15, wildly
    // outside the range => output 2.
    inputs: { unit: 'MB', greaterThan: '7000', lessThan: '9000' },
    command: false,
  },
  { rel: 'tools/processedCheck/1.0.0/index.js', inputs: {}, command: false },
];

describe.runIf(available)('Tdarr community flow plugins', () => {
  it('reports where the corpus came from', () => {
    expect(existsSync(CORPUS_DIR)).toBe(true);
  });

  for (const testCase of CASES) {
    const abs = pluginPath(testCase.rel);

    describe(testCase.rel, () => {
      it.runIf(existsSync(abs))('loads and exposes usable details()', () => {
        const loaded = createPluginLoader().load(abs);
        expect(loaded.details.name).toBeTruthy();
        expect(loaded.details.outputs.length).toBeGreaterThan(0);
        expect(Array.isArray(loaded.details.inputs)).toBe(true);
      });

      it.runIf(existsSync(abs))('executes and returns a routable output number', async () => {
        const loaded = createPluginLoader().load(abs);
        const output = await loaded.module.plugin(argsFor(testCase.inputs, testCase.command));
        expect(typeof output.outputNumber).toBe('number');
        expect(output.outputNumber).toBeGreaterThanOrEqual(1);
        const numbers = loaded.details.outputs.map((o) => o.number);
        expect(numbers).toContain(output.outputNumber);
      });
    });
  }
});

describe.runIf(available)('checkFileSize proves file_size is projected in megabytes', () => {
  const abs = pluginPath('file/checkFileSize/1.0.0/index.js');

  it.runIf(existsSync(abs))('routes a 8000MB file into a [7000MB, 9000MB) range', async () => {
    const loaded = createPluginLoader().load(abs);
    const args = argsFor({ unit: 'MB', greaterThan: '7000', lessThan: '9000' }, false);

    // The fixture file is 8_000_000_000 bytes. If `file_size` is correctly
    // projected in MB (8000), the plugin's own arithmetic
    // (file_size * 1000 * 1000, per index.js:75) lands inside the range and
    // routes to output 1. If `file_size` were left in bytes (the historical
    // bug), the same arithmetic overshoots by a factor of a million and
    // routes to output 2. This is the assertion that actually exercises the
    // unit — a bare "returns some routable number" check would pass either
    // way, which is how the original bug slipped through.
    expect(args.inputFileObj.file_size).toBe(8000);

    const output = await loaded.module.plugin(args);
    expect(output.outputNumber).toBe(1);
  });
});

describe.runIf(available)('ffmpegCommand cooperation across community plugins', () => {
  const abs = pluginPath('ffmpegCommand/ffmpegCommandSetVideoEncoder/1.0.0/index.js');

  it.runIf(existsSync(abs))('produces a compilable command', async () => {
    const loaded = createPluginLoader().load(abs);
    const args = argsFor({ outputCodec: 'hevc', ffmpegPreset: 'medium' }, true);
    const output = await loaded.module.plugin(args);

    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/staging/out.mkv',
    });

    expect(argv).toContain('-i');
    expect(argv.at(-1)).toBe('/staging/out.mkv');
    expect(argv.filter((a) => a === '-map').length).toBeGreaterThan(0);
  });
});
