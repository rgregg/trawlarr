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
      // These assert existence rather than gating on it (`it.runIf`). A plugin
      // directory that upstream renamed or version-bumped IS the drift this
      // suite exists to detect, so it must fail rather than silently skip —
      // otherwise the nightly compatibility job reports green while running
      // nothing. Skipping when the corpus was never fetched at all is handled
      // once, by the outer `describe.runIf(available)`.
      it('loads and exposes usable details()', () => {
        expect(existsSync(abs)).toBe(true);
        const loaded = createPluginLoader().load(abs);
        expect(loaded.details.name).toBeTruthy();
        expect(loaded.details.outputs.length).toBeGreaterThan(0);
        expect(Array.isArray(loaded.details.inputs)).toBe(true);
      });

      it('executes and returns a routable output number', async () => {
        expect(existsSync(abs)).toBe(true);
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

describe.runIf(available)('checkVideoCodec routes on the projected video codec', () => {
  const abs = pluginPath('video/checkVideoCodec/1.0.0/index.js');

  // The fixture's video stream is h264. checkVideoCodec walks
  // `args.inputFileObj.ffProbeData.streams` and matches `codec_type ===
  // 'video' && codec_name === inputs.codec`, so the output number is a direct
  // function of the projected probe. Asking for both the codec the file HAS
  // and one it does NOT makes each answer falsifiable: a broken projection
  // (missing streams, wrong field names, subtitle/audio streams misreported as
  // video) collapses both cases onto output 2, and asserting only "some
  // routable number" would not notice.
  it('routes to "has codec" when asked for the codec the file actually has', async () => {
    expect(existsSync(abs)).toBe(true);
    const loaded = createPluginLoader().load(abs);
    const args = argsFor({ codec: 'h264' }, false);
    expect(args.inputFileObj.ffProbeData.streams?.[0]?.codec_name).toBe('h264');

    const output = await loaded.module.plugin(args);
    expect(output.outputNumber).toBe(1);
  });

  it('routes to "does not have codec" for a codec the file lacks', async () => {
    expect(existsSync(abs)).toBe(true);
    const loaded = createPluginLoader().load(abs);
    const output = await loaded.module.plugin(argsFor({ codec: 'hevc' }, false));
    expect(output.outputNumber).toBe(2);
  });
});

describe.runIf(available)('processedCheck round-trips through crudTransDBN', () => {
  const abs = pluginPath('tools/processedCheck/1.0.0/index.js');
  const SKIPLIST = 'F2FOutputJSONDB';
  const key = `${SKIPLIST}::/media/movies/Sample.mkv`;

  // processedCheck ("Check Skiplist") reads the host document store:
  // `crudTransDBN('F2FOutputJSONDB', 'getById', <file path>, {})` and routes to
  // output 2 only when the stored document's `DB` matches the file object's
  // `DB` (the library id). Driving it both ways is what proves the store is
  // genuinely wired: a crudTransDBN that always returned undefined, or a file
  // object with a missing `DB`, would still produce "a routable output number"
  // — it would just always be 1.
  it('reports not-on-skiplist when the document store is empty', async () => {
    expect(existsSync(abs)).toBe(true);
    documents.delete(key);
    const loaded = createPluginLoader().load(abs);
    const output = await loaded.module.plugin(argsFor({ checkType: 'filePath' }, false));
    expect(output.outputNumber).toBe(1);
  });

  it('sees a file the host previously wrote to the skiplist collection', async () => {
    expect(existsSync(abs)).toBe(true);
    const args = argsFor({ checkType: 'filePath' }, false);
    // Write through the same deps.crudTransDBN the plugin reads through, so
    // this is a genuine round trip rather than a poke at the backing map.
    await deps.crudTransDBN(SKIPLIST, 'insert', args.inputFileObj._id, {
      DB: args.inputFileObj.DB,
    });
    expect(documents.get(key)).toEqual({ DB: 'lib1' });

    const loaded = createPluginLoader().load(abs);
    const output = await loaded.module.plugin(args);
    expect(output.outputNumber).toBe(2);
    documents.delete(key);
  });
});

describe.runIf(available)('checkFileSize proves file_size is projected in megabytes', () => {
  const abs = pluginPath('file/checkFileSize/1.0.0/index.js');

  it('routes a 8000MB file into a [7000MB, 9000MB) range', async () => {
    expect(existsSync(abs)).toBe(true);
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

  it('produces a compilable command', async () => {
    expect(existsSync(abs)).toBe(true);
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

describe.runIf(available)('ffmpegCommandRorderStreams', () => {
  const abs = pluginPath('ffmpegCommand/ffmpegCommandRorderStreams/1.0.0/index.js');

  it('reorders streams while keeping each mapped to its source track', async () => {
    expect(existsSync(abs)).toBe(true);
    const loaded = createPluginLoader().load(abs);
    // Reorder by stream type so video leads. The fixture's streams are seeded
    // in probe order, so this genuinely moves them and array position stops
    // matching the source track — which is the case that used to mis-map.
    const args = argsFor(
      {
        processOrder: 'streamTypes',
        streamTypes: 'audio,video,subtitle',
        languages: '',
        channels: '',
        codecs: '',
      },
      true,
    );
    const probeOrder = args.variables.ffmpegCommand.streams.map((stream) => stream.codec_type);

    const output = await loaded.module.plugin(args);
    const reorderedStreams = output.variables.ffmpegCommand.streams;

    // Guard against silent coverage loss: if upstream ever renames
    // `streamTypes`/`processOrder`, the plugin ignores the unknown input and
    // returns the streams untouched, so position and source identity would
    // coincide trivially and everything below would pass having exercised
    // nothing. Fail loudly here instead, pointing at upstream drift rather
    // than at trawlarr.
    expect(reorderedStreams.map((stream) => stream.codec_type)).not.toEqual(probeOrder);
    expect(reorderedStreams.map((stream) => stream.codec_type)).toEqual([
      'audio',
      'video',
      'subtitle',
    ]);

    // Overwrite one surviving stream's mapArgs with a value that is NOT
    // derivable from its `index` field ('0:v:0' vs. the video stream's
    // index of 0, which would derive as '0:0'). The plugin itself never
    // touches mapArgs — it only clones and reorders — so deriving the
    // expectation as `0:${stream.index}` (as an earlier version of this test
    // did) is mathematically identical to what mapArgs already contains and
    // passes just as well for a compiler that ignores mapArgs and
    // recomputes from index. Mutating mapArgs to a non-derivable value after
    // the plugin runs, and asserting the compiler emits exactly that, is
    // what proves mapArgs is actually read rather than recomputed.
    const videoStream = reorderedStreams.find((stream) => stream.codec_type === 'video');
    if (!videoStream) throw new Error('expected a video stream to survive the reorder');
    videoStream.mapArgs = ['-map', '0:v:0'];

    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/staging/out.mkv',
    });

    const maps = argv.reduce<string[]>(
      (acc, arg, i) => (arg === '-map' ? [...acc, argv[i + 1] ?? ''] : acc),
      [],
    );
    const expectedMaps = reorderedStreams.map((stream) =>
      stream === videoStream ? '0:v:0' : `0:${stream.index}`,
    );
    expect(maps).toEqual(expectedMaps);
  });
});

describe.runIf(available)('ffmpegCommandEnsureAudioStream', () => {
  const abs = pluginPath('ffmpegCommand/ffmpegCommandEnsureAudioStream/1.0.0/index.js');

  it('adds a stream whose placeholder arguments resolve to real indices', async () => {
    expect(existsSync(abs)).toBe(true);
    const loaded = createPluginLoader().load(abs);
    const args = argsFor(
      {
        audioEncoder: 'aac',
        language: 'en',
        channels: '2',
        // Bitrate on, so the plugin also emits a '-b:a:{outputTypeIndex}'
        // argument and the type-index placeholder is exercised too.
        enableBitrate: 'true',
        bitrate: '128k',
        enableSamplerate: 'false',
      },
      true,
    );
    const output = await loaded.module.plugin(args);

    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/staging/out.mkv',
    });

    // The plugin writes literal '-c:{outputIndex}' and '-b:a:{outputTypeIndex}'.
    // Reaching ffmpeg unresolved, those are a hard failure.
    expect(argv.join(' ')).not.toContain('{outputIndex}');
    expect(argv.join(' ')).not.toContain('{outputTypeIndex}');
    expect(argv.some((arg) => /^-c:\d+$/.test(arg))).toBe(true);
  });
});
