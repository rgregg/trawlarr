import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { beginFfmpegCommand, compileFfmpegArgs, emptyFfmpegCommand } from '@trawlarr/core';
import { createPluginLoader } from '../../src/host/loader.js';
import { buildPluginDeps } from '../../src/host/deps.js';
import { createCrudTransDbn } from '../../src/host/crud-trans-dbn.js';
import { createAxiosMiddleware } from '../../src/host/axios-middleware.js';
import { toPluginFileObject } from '../../src/host/file-object.js';
import { CORPUS_DIR, corpusAvailable, pluginPath } from './corpus.js';

const available = corpusAvailable();

if (!available) {
  console.warn(
    '[compat] Tdarr plugin corpus not found at ' +
      CORPUS_DIR +
      ' — skipping parity plugin tests. Run `pnpm compat:fetch` first.',
  );
}

/**
 * A real disc-rip shape: cover art first, then video, then three audio tracks
 * (English 5.1, Japanese stereo, and one with NO language tag), then a
 * subtitle. The untagged track is the important one — his Unmanic config sets
 * `keep_undefined`, and this fixture is what proves the Tdarr plugin already
 * behaves that way without it.
 */
const probe: ProbeData = {
  format: { duration: '1440.0', bit_rate: '8000000', nb_streams: 6, size: '8000000000' },
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'mjpeg',
      width: 600,
      height: 900,
      disposition: { attached_pic: 1 },
    },
    { index: 1, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'eng' } },
    { index: 3, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'jpn' } },
    { index: 4, codec_type: 'audio', codec_name: 'ac3', channels: 6 },
    { index: 5, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
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
    workDir: '/tmp/trawlarr-parity',
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

const SET_CONTAINER = 'ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js';
const ENSURE_AUDIO = 'ffmpegCommand/ffmpegCommandEnsureAudioStream/1.0.0/index.js';
const REMOVE_BY_PROPERTY = 'ffmpegCommand/ffmpegCommandRemoveStreamByProperty/1.0.0/index.js';
const CUSTOM_ARGUMENTS = 'ffmpegCommand/ffmpegCommandCustomArguments/1.0.0/index.js';
const WEB_REQUEST = 'tools/webRequest/1.0.0/index.js';
const NOTIFY_ARR = 'tools/notifyRadarrOrSonarr/1.0.0/index.js';

const run = async (rel: string, inputs: Record<string, unknown>, withCommand: boolean) => {
  const abs = pluginPath(rel);
  // Assert existence rather than gating on it: a directory upstream renamed or
  // version-bumped IS the drift this suite exists to detect, and `it.runIf`
  // would report green while running nothing.
  expect(existsSync(abs)).toBe(true);
  const loaded = createPluginLoader().load(abs);
  const args = argsFor(inputs, withCommand);
  const output = await loaded.module.plugin(args);
  expect(loaded.details.outputs.map((o) => o.number)).toContain(output.outputNumber);
  return { loaded, args, output };
};

describe.runIf(available)('Set Container', () => {
  it('remuxes to mp4 by setting the container and marking the command for processing', async () => {
    const { output } = await run(SET_CONTAINER, { container: 'mp4', forceConform: false }, true);
    expect(output.variables.ffmpegCommand.container).toBe('mp4');
    expect(output.variables.ffmpegCommand.shouldProcess).toBe(true);
  });

  it('does nothing when the file is already in the requested container', async () => {
    // The fixture's path is Sample.mkv. Asking for mkv must leave the command
    // untouched, which is what makes this node free on a converged library —
    // `deriveShouldProcess` then reports no work and Execute skips ffmpeg.
    const { output } = await run(SET_CONTAINER, { container: 'mkv', forceConform: false }, true);
    expect(output.variables.ffmpegCommand.shouldProcess).toBe(false);
    expect(output.variables.ffmpegCommand.streams.some((s) => s.removed === true)).toBe(false);
  });
});

describe.runIf(available)('Remove Stream By Property', () => {
  it('removes audio whose language is not English, and keeps the English track', async () => {
    const { output } = await run(
      REMOVE_BY_PROPERTY,
      {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      true,
    );
    const streams = output.variables.ffmpegCommand.streams;
    // Index 2 is the English track and survives; index 3 is Japanese and goes.
    expect(streams[2]!.removed).toBe(false);
    expect(streams[3]!.removed).toBe(true);
  });

  it('never removes a stream whose language tag is absent', async () => {
    // His Unmanic config sets `keep_undefined` explicitly. This asserts the
    // Tdarr plugin already behaves that way unconditionally, which is why no
    // first-party equivalent and no extra safety input is needed on the NODE.
    // The catastrophic case it guards is a rip whose audio carries no
    // language metadata at all: without this, `not_includes eng` deletes
    // every audio track in the library.
    const { output } = await run(
      REMOVE_BY_PROPERTY,
      {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      true,
    );
    expect(output.variables.ffmpegCommand.streams[4]!.removed).toBe(false);
  });

  it('leaves the video stream and the cover art alone when filtering audio', async () => {
    const { output } = await run(
      REMOVE_BY_PROPERTY,
      {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      true,
    );
    const streams = output.variables.ffmpegCommand.streams;
    // beginFfmpegCommand reclassifies attached_pic to 'attachment', so a
    // codecType filter of 'audio' cannot reach it. Pinned because the
    // reclassification is a trawlarr divergence from upstream and a community
    // plugin has to keep working across it.
    expect(streams[0]!.codec_type).toBe('attachment');
    expect(streams[0]!.removed).toBe(false);
    expect(streams[1]!.removed).toBe(false);
  });

  it('compiles to argv that maps every surviving stream and no removed one', async () => {
    const { output } = await run(
      REMOVE_BY_PROPERTY,
      {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      true,
    );
    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/tmp/out.mkv',
    });
    // mapArgs are seeded '-map 0:<ffprobe index>'. The Japanese track is
    // input index 3, and its map must be absent; every other index present.
    const maps = argv.filter((_, i) => argv[i - 1] === '-map');
    expect(maps).toEqual(['0:0', '0:1', '0:2', '0:4', '0:5']);
  });
});

describe.runIf(available)('Ensure Audio Stream', () => {
  it('adds a stereo aac stream when none exists, without removing anything', async () => {
    // The fixture has an English 5.1 ac3 track but no English stereo aac
    // track, so this plugin ADDS one. That is the semantic difference from
    // Unmanic's "ensure 2ch aac", which converts — see the migration guide.
    const { output } = await run(
      ENSURE_AUDIO,
      { audioEncoder: 'aac', language: 'eng', channels: 2 },
      true,
    );
    const streams = output.variables.ffmpegCommand.streams;
    expect(streams.length).toBe(7);
    expect(streams.some((s) => s.removed === true)).toBe(false);
    expect(output.variables.ffmpegCommand.shouldProcess).toBe(true);
  });

  it('adds nothing on a second pass, so a converged file stays converged', async () => {
    const first = await run(
      ENSURE_AUDIO,
      { audioEncoder: 'aac', language: 'jpn', channels: 2 },
      true,
    );
    // The fixture already has a Japanese 2-channel aac track (index 3), so the
    // plugin must find it and add nothing. This is the property the
    // convergence ledger depends on: a node that added a stream every run
    // would grow the file for ever.
    expect(first.output.variables.ffmpegCommand.streams.length).toBe(6);
  });
});

describe.runIf(available)('Custom Arguments', () => {
  it('carries his -max_muxing_queue_size 2048 into the overall output arguments', async () => {
    const { output } = await run(
      CUSTOM_ARGUMENTS,
      { inputArguments: '', outputArguments: '-max_muxing_queue_size 2048' },
      true,
    );
    expect(output.variables.ffmpegCommand.overallOuputArguments).toEqual([
      '-max_muxing_queue_size',
      '2048',
    ]);
    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/tmp/out.mkv',
    });
    expect(argv.slice(-3)).toEqual(['-max_muxing_queue_size', '2048', '/tmp/out.mkv']);
  });
});

describe.runIf(available)('Send Web Request', () => {
  let server: Server;
  let received: { method: string; url: string; body: string } | null = null;
  let base = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('performs the Plex partial-scan request shape and routes to output 1', async () => {
    const { output } = await run(
      WEB_REQUEST,
      {
        method: 'get',
        requestUrl: `${base}/library/sections/1/refresh?X-Plex-Token=abc123`,
        requestHeaders: '{"Accept":"application/json"}',
        requestBody: '{}',
        logResponseBody: false,
        output2StatusCodes: '',
        output2OnNetworkError: false,
      },
      false,
    );
    expect(output.outputNumber).toBe(1);
    expect(received?.method).toBe('GET');
    expect(received?.url).toBe('/library/sections/1/refresh?X-Plex-Token=abc123');
  });

  it('routes a network error to output 2 when configured to, instead of failing the flow', async () => {
    // A Plex that is down must not invalidate a transcode that already
    // succeeded. This input is what lets a flow author say so.
    const { output } = await run(
      WEB_REQUEST,
      {
        method: 'get',
        // Port 1 is reserved and refuses connections on every platform.
        requestUrl: 'http://127.0.0.1:1/library/sections/1/refresh',
        requestHeaders: '{}',
        requestBody: '{}',
        logResponseBody: false,
        output2StatusCodes: '',
        output2OnNetworkError: true,
      },
      false,
    );
    expect(output.outputNumber).toBe(2);
  });
});

describe.runIf(available)('Notify Radarr or Sonarr', () => {
  it('loads and exposes usable details()', () => {
    const abs = pluginPath(NOTIFY_ARR);
    expect(existsSync(abs)).toBe(true);
    const loaded = createPluginLoader().load(abs);
    expect(loaded.details.name).toBeTruthy();
    expect(loaded.details.outputs.length).toBeGreaterThan(0);
  });
});
