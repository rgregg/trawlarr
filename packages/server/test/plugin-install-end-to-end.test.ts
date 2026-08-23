import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createLibraryRepo } from '../src/db/library-repo.js';
import { createFlowRepo } from '../src/db/flow-repo.js';
import { createMediaFileRepo } from '../src/db/media-file-repo.js';
import { isKnownGood } from '@trawlarr/core';
import { createPluginRepo } from '../src/plugins/plugin-repo.js';
import { discoverFlowPlugins } from '../src/plugins/sync-source.js';
import { checkAllLibraries } from '../src/daemon/library-health.js';
import { createEventBus } from '../src/daemon/events.js';
import { ffmpegAvailableSync } from '../../../test-support/tool-availability.js';
import { CORPUS_DIR, corpusAvailable } from '../../engine/test/compat/corpus.js';

const execFileAsync = promisify(execFile);

// Read synchronously at COLLECTION time, like every other gated suite here:
// an availability check behind an async `beforeAll` silently skips the whole
// suite and still reports green.
const available = ffmpegAvailableSync() && corpusAvailable();

const CLI_PATH = join(process.cwd(), 'packages/server/dist/cli.js');

const runCli = (args: string[]) =>
  execFileAsync('node', [CLI_PATH, ...args], { maxBuffer: 10 * 1024 * 1024 });

/** Newest mtime of any file under `dir`, recursively. */
const newestMtimeMs = (dir: string): number => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs);
  }
  return newest;
};

/** The same freshness guard `end-to-end.test.ts` uses: this suite drives BUILT output. */
const assertBuiltCliIsFresh = (): void => {
  const srcDir = join(process.cwd(), 'packages/server/src');
  if (!existsSync(CLI_PATH)) {
    throw new Error(`${CLI_PATH} does not exist. Run "pnpm build" before this suite.`);
  }
  const builtAt = statSync(CLI_PATH).mtimeMs;
  const newestSource = newestMtimeMs(srcDir);
  if (builtAt < newestSource) {
    throw new Error(
      `${CLI_PATH} (built ${new Date(builtAt).toISOString()}) is older than the newest file ` +
        `under packages/server/src (${new Date(newestSource).toISOString()}) — this suite would ` +
        `be exercising STALE compiled output. Run "pnpm build" first.`,
    );
  }
};

const openStateDb = (dataDir: string): Db => {
  const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
  migrate(db);
  return db;
};

const formatNameOf = async (path: string): Promise<string> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=format_name',
    '-of',
    'csv=p=0',
    path,
  ]);
  return stdout.trim();
};

/**
 * A flow whose ONLY transformation is a community plugin installed from a
 * source. Everything else is first-party host machinery, so the one thing
 * that can make this flow work or fail is installed-plugin resolution.
 */
const remuxFlow = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'begin', pluginId: 'trawlarr:beginCommand', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'container',
      pluginId: 'tdarr:ffmpegCommandSetContainer',
      pluginVersion: '1.0.0',
      inputs: { container: 'mp4', forceConform: 'true' },
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
    { fromNodeId: 'start', outputNumber: 1, toNodeId: 'begin' },
    { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'container' },
    { fromNodeId: 'container', outputNumber: 1, toNodeId: 'execute' },
    { fromNodeId: 'execute', outputNumber: 1, toNodeId: 'verify' },
    { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
  ],
};

/**
 * A flow whose only step after Start is upstream's Fail Flow — the plugin
 * that declares `outputs: []` and throws on purpose. Valid as written: no
 * edge leaves the terminal node, which is the only thing flow validation
 * forbids about one.
 */
const failFlowFlow = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'bail', pluginId: 'tdarr:failFlow', pluginVersion: '1.0.0', inputs: {} },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'bail' }],
};

/** Every stream ffprobe reports, with the fields these assertions read. */
const streamsOf = async (
  path: string,
): Promise<
  { codec_type: string; codec_name: string; channels?: number; tags?: { language?: string } }[]
> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-of',
    'json',
    path,
  ]);
  return (
    JSON.parse(stdout) as {
      streams: {
        codec_type: string;
        codec_name: string;
        channels?: number;
        tags?: { language?: string };
      }[];
    }
  ).streams;
};

const md5Of = (path: string): string => createHash('md5').update(readFileSync(path)).digest('hex');

/** A 1s test file, enough for the scanner and ffprobe to have something real. */
const makeSample = async (path: string): Promise<void> => {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    path,
  ]); // prettier-ignore
};

describe.runIf(available)('installing a community plugin and running it', () => {
  beforeAll(() => {
    assertBuiltCliIsFresh();
  });

  it('remuxes a real file through a flow that names an installed plugin', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'trawlarr-install-e2e-'));
    const libraryDir = join(workDir, 'library');
    const dataDir = join(workDir, 'data');
    mkdirSync(libraryDir, { recursive: true });
    const mediaPath = join(libraryDir, 'Sample.mkv');
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
    expect(await formatNameOf(mediaPath)).toContain('matroska');

    // The library first: it is what creates the data directory the source
    // is installed into.
    await runCli(['library', 'add', '--name', 'Movies', '--root', libraryDir, '--data-dir', dataDir]); // prettier-ignore

    // The corpus IS a local plugin source — no network, and the same tree
    // the compat suites run against. Added and synced through the REAL CLI,
    // so this suite walks exactly the path a user walks: two commands, then
    // a flow that names one of the plugins they installed.
    await runCli(['plugin', 'source', 'add', '--name', 'tdarr', '--path', CORPUS_DIR, '--data-dir', dataDir]); // prettier-ignore
    await runCli(['plugin', 'source', 'sync', '--name', 'tdarr', '--data-dir', dataDir]);
    {
      const db = openStateDb(dataDir);
      const repo = createPluginRepo(db);
      // Rows, not the CLI's own summary line: the source is stored and the
      // plugin the flow below names is installed, with its file on disk.
      expect(repo.listSources().map((source) => source.id)).toEqual(['tdarr']);
      expect(repo.listPlugins('tdarr').length).toBeGreaterThan(0);
      const row = repo.getPlugin('tdarr:ffmpegCommandSetContainer');
      expect(row).not.toBeNull();
      expect(existsSync(row!.absPath)).toBe(true);
      db.close();
    }

    // Storing the flow runs `createFlowRepo`'s validation, which must now
    // RESOLVE `tdarr:ffmpegCommandSetContainer` — including its output
    // numbers, since routing an undeclared output is rejected.
    const flowPath = join(workDir, 'flow.json');
    writeFileSync(flowPath, JSON.stringify(remuxFlow), 'utf8');
    await runCli(['flow', 'add', '--name', 'Remux', '--file', flowPath, '--data-dir', dataDir]);
    await runCli(['library', 'set-flow', '--library', 'Movies', '--flow', 'Remux', '--data-dir', dataDir]); // prettier-ignore

    await runCli(['scan', '--library', 'Movies', '--data-dir', dataDir]);
    await runCli(['run', '--library', 'Movies', '--data-dir', dataDir]);

    // The observable outcome: the library file is now an mp4, at the stem
    // the user's file had. Not a log line, not an exit code.
    const remuxedPath = join(libraryDir, 'Sample.mp4');
    expect(existsSync(remuxedPath)).toBe(true);
    expect(await formatNameOf(remuxedPath)).toContain('mp4');
    expect(existsSync(mediaPath)).toBe(false);

    const db = openStateDb(dataDir);
    try {
      const library = createLibraryRepo(db).getByName('Movies')!;
      // Library health, the call site whose omission would have paused this
      // library the moment its flow named an installed plugin.
      expect(library.enabled).toBe(true);
      expect(library.pausedReason).toBeNull();

      const counts = createMediaFileRepo(db).countsByState(library.id);
      expect(counts.good).toBe(1);
      expect(counts.failed).toBe(0);
      expect(counts.queued).toBe(0);

      // And the daemon's OWN health check, run against this real data
      // directory and this real installed source: a resolver that misses
      // the registry pauses the library here, with "this host cannot
      // resolve it", the moment a daemon starts. The `run` CLI never asks,
      // which is exactly why this is asserted explicitly.
      const health = checkAllLibraries({ db, bus: createEventBus() });
      expect(health.map((entry) => entry.reason)).toEqual([null]);
      expect(createLibraryRepo(db).getById(library.id)!.enabled).toBe(true);
    } finally {
      db.close();
    }
  }, 300_000);

  it('installs every plugin the real corpus ships, rejecting none for declaring no outputs', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'trawlarr-corpus-sync-'));
    const libraryDir = join(workDir, 'library');
    const dataDir = join(workDir, 'data');
    mkdirSync(libraryDir, { recursive: true });

    await runCli(['library', 'add', '--name', 'Movies', '--root', libraryDir, '--data-dir', dataDir]); // prettier-ignore
    await runCli(['plugin', 'source', 'add', '--name', 'tdarr', '--path', CORPUS_DIR, '--data-dir', dataDir]); // prettier-ignore
    await runCli(['plugin', 'source', 'sync', '--name', 'tdarr', '--data-dir', dataDir]);

    const db = openStateDb(dataDir);
    try {
      const repo = createPluginRepo(db);
      // Rows in the database, not the CLI's summary line. Every candidate
      // discovery found is installed: before the fix this was 89 rows with
      // failFlow and goToFlow thrown away as "details() declares no outputs".
      const installed = repo.listPlugins('tdarr');
      expect(installed.length).toBe(discoverFlowPlugins(CORPUS_DIR).length);
      expect(repo.getPlugin('tdarr:failFlow')).not.toBeNull();
      expect(repo.getPlugin('tdarr:goToFlow')).not.toBeNull();
      // And they are installed AS terminal nodes: the empty declaration is
      // what flow validation reads to forbid an edge leaving them.
      expect(repo.getPlugin('tdarr:failFlow')!.details.outputs).toEqual([]);
      expect(repo.getPlugin('tdarr:goToFlow')!.details.outputs).toEqual([]);
    } finally {
      db.close();
    }
  }, 300_000);

  /**
   * The owner's real Unmanic pipeline, as the `conform-library` template, run
   * end to end through the REAL CLI against REAL ffmpeg — in its libx265
   * form, because this machine has no NVIDIA card and the `hevc_nvenc` form
   * shipped beside it can only be proven on his.
   *
   * It also pins the ONE place the template is not literal Unmanic parity:
   * `Ensure Audio Stream` ADDS a stereo AAC track, it does not CONVERT the
   * 5.1 one. The 6-channel track surviving next to the new 2-channel one is
   * that difference, asserted rather than described.
   */
  it('conforms a real file: mp4 to mkv, h264 to hevc, stereo AAC added, non-English audio dropped', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'trawlarr-conform-e2e-'));
    const libraryDir = join(workDir, 'library');
    const dataDir = join(workDir, 'data');
    mkdirSync(libraryDir, { recursive: true });
    const mediaPath = join(libraryDir, 'Movie.mp4');

    // h264 in mp4, with 5.1 AAC tagged eng and stereo AAC tagged jpn: one
    // file that needs every node in the flow to do something.
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', '-ac:a:0', '6', '-ac:a:1', '2',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
      mediaPath,
    ]); // prettier-ignore

    const videoCodecs = (streams: Awaited<ReturnType<typeof streamsOf>>) =>
      streams.filter((s) => s.codec_type === 'video').map((s) => s.codec_name);
    const audioTracks = (streams: Awaited<ReturnType<typeof streamsOf>>) =>
      streams
        .filter((s) => s.codec_type === 'audio')
        .map((s) => [s.codec_name, s.channels, s.tags?.language]);

    const before = await streamsOf(mediaPath);
    expect(videoCodecs(before)).toEqual(['h264']);
    expect(audioTracks(before)).toEqual([
      ['aac', 6, 'eng'],
      ['aac', 2, 'jpn'],
    ]);

    await runCli(['library', 'add', '--name', 'Movies', '--root', libraryDir, '--data-dir', dataDir]); // prettier-ignore
    await runCli(['plugin', 'source', 'add', '--name', 'tdarr', '--path', CORPUS_DIR, '--data-dir', dataDir]); // prettier-ignore
    await runCli(['plugin', 'source', 'sync', '--name', 'tdarr', '--data-dir', dataDir]);

    // The template, through the CLI, with only the two settings that differ
    // from his: libx265 in place of hevc_nvenc, and no preset (a preset name
    // is encoder-specific and the template leaves it unset for that reason).
    await runCli([
      'flow', 'add', '--name', 'Conform', '--template', 'conform-library',
      '--set', 'encoder=libx265', '--set', 'quality=23',
      '--data-dir', dataDir,
    ]); // prettier-ignore
    await runCli(['library', 'set-flow', '--library', 'Movies', '--flow', 'Conform', '--data-dir', dataDir]); // prettier-ignore
    await runCli(['scan', '--library', 'Movies', '--data-dir', dataDir]);
    await runCli(['run', '--library', 'Movies', '--data-dir', dataDir]);

    // The file on disk, not a log line: remuxed to mkv at the same stem.
    const outPath = join(libraryDir, 'Movie.mkv');
    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(mediaPath)).toBe(false);
    expect(await formatNameOf(outPath)).toContain('matroska');

    const after = await streamsOf(outPath);
    expect(videoCodecs(after)).toEqual(['hevc']);
    expect(audioTracks(after)).toEqual([
      // The 5.1 English track SURVIVES: the plugin added a stereo track, it
      // did not convert this one. Unmanic's ensure_2ch_aac_audio would have
      // left only the stereo track here.
      ['aac', 6, 'eng'],
      // Added by Ensure Audio Stream, in the language asked for.
      ['aac', 2, 'eng'],
    ]);
    // And the Japanese track is gone, which is the language filter working.
    expect(after.some((s) => s.tags?.language === 'jpn')).toBe(false);

    const db = openStateDb(dataDir);
    try {
      const library = createLibraryRepo(db).getByName('Movies')!;
      expect(library.enabled).toBe(true);
      expect(library.pausedReason).toBeNull();
      const counts = createMediaFileRepo(db).countsByState(library.id);
      expect(counts.good).toBe(1);
      expect(counts.failed).toBe(0);

      // The muxing-queue flag reached the invocation that actually encoded.
      // It is a mitigation for "Too many packets buffered for output stream"
      // DURING an encode, so the encode branch is the one path it must never
      // be lost from — and moving it off the common path is exactly the kind
      // of change that could lose it.
      const step = db
        .prepare(
          `SELECT log_excerpt FROM job_step WHERE plugin_id = 'trawlarr:execute' ORDER BY seq`,
        )
        .get() as { log_excerpt: string };
      expect(step.log_excerpt).toContain('Running:');
      expect(step.log_excerpt).toContain('-max_muxing_queue_size 2048');
    } finally {
      db.close();
    }
  }, 300_000);

  /**
   * The other half of the same template: a file that is ALREADY in the state
   * the flow wants must produce no work at all.
   *
   * This is the regression test for a template bug that cost a real 8.4 TB
   * library ~6.5 TB of churn. `muxqueue` (`ffmpegCommandCustomArguments`,
   * `-max_muxing_queue_size 2048`) sat on BOTH branches of the codec check,
   * so a converged file arrived at Execute carrying overall output arguments
   * — which `deriveShouldProcess` reads as work, and which the no-op gate
   * reports as a difference the output would carry. All 4,621 files queued,
   * each remuxed to say what it already said, with ~1,453 MB of original
   * pushed into a 14-day trash. The engine was right; the flow was wrong.
   *
   * The fixture is the real library's converged shape: hevc video, aac 2ch
   * eng (which satisfies `Ensure Audio Stream`, so it adds nothing) and eac3
   * 6ch eng, in mkv. Asserted on the decision and on the bytes, never on the
   * flow's JSON — a test that grepped the template would pass against any
   * rearrangement that kept the string.
   */
  it('leaves a file already in the target state untouched: no encode, no remux, no trash', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'trawlarr-conform-converged-'));
    const libraryDir = join(workDir, 'library');
    const dataDir = join(workDir, 'data');
    mkdirSync(libraryDir, { recursive: true });
    const mediaPath = join(libraryDir, 'Converged.mkv');

    // hevc + aac 2ch eng + eac3 6ch eng, in mkv: every node in the conform
    // flow has nothing to do with this file.
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=none',
      '-c:a:0', 'aac', '-ac:a:0', '2',
      '-c:a:1', 'eac3', '-ac:a:1', '6',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=eng',
      mediaPath,
    ]); // prettier-ignore

    // Guard against the fixture silently not being converged: if ffmpeg ever
    // produced something other than this, the test below would be asserting
    // nothing interesting.
    const before = await streamsOf(mediaPath);
    expect(before.map((s) => [s.codec_type, s.codec_name, s.channels, s.tags?.language])).toEqual([
      ['video', 'hevc', undefined, undefined],
      ['audio', 'aac', 2, 'eng'],
      ['audio', 'eac3', 6, 'eng'],
    ]);
    const md5Before = md5Of(mediaPath);
    const sizeBefore = statSync(mediaPath).size;

    await runCli(['library', 'add', '--name', 'Movies', '--root', libraryDir, '--data-dir', dataDir]); // prettier-ignore
    await runCli(['plugin', 'source', 'add', '--name', 'tdarr', '--path', CORPUS_DIR, '--data-dir', dataDir]); // prettier-ignore
    await runCli(['plugin', 'source', 'sync', '--name', 'tdarr', '--data-dir', dataDir]);
    await runCli([
      'flow', 'add', '--name', 'Conform', '--template', 'conform-library',
      '--set', 'encoder=libx265', '--set', 'quality=23',
      '--data-dir', dataDir,
    ]); // prettier-ignore
    await runCli(['library', 'set-flow', '--library', 'Movies', '--flow', 'Conform', '--data-dir', dataDir]); // prettier-ignore
    await runCli(['scan', '--library', 'Movies', '--data-dir', dataDir]);
    await runCli(['run', '--library', 'Movies', '--data-dir', dataDir]);

    // Byte for byte the file it was, at the path it was, with nothing in
    // trash waiting out a 14-day retention.
    expect(existsSync(mediaPath)).toBe(true);
    expect(md5Of(mediaPath)).toBe(md5Before);
    expect(statSync(mediaPath).size).toBe(sizeBefore);
    const trashDir = join(libraryDir, '.trawlarr', 'trash');
    expect(existsSync(trashDir) ? readdirSync(trashDir) : []).toEqual([]);

    const db = openStateDb(dataDir);
    try {
      const library = createLibraryRepo(db).getByName('Movies')!;
      const counts = createMediaFileRepo(db).countsByState(library.id);
      // Converged, not failed and not re-queued.
      expect(counts.good).toBe(1);
      expect(counts.failed + counts.held + counts.queued).toBe(0);

      // The DECISION, in the one place an operator can read it after the
      // fact. Before the fix this said "Running: ffmpeg …
      // -max_muxing_queue_size 2048" with the video at `-c:0 copy`.
      const step = db
        .prepare(
          `SELECT output_number, log_excerpt FROM job_step WHERE plugin_id = 'trawlarr:execute' ORDER BY seq`,
        )
        .get() as { output_number: number; log_excerpt: string };
      expect(step.output_number).toBe(1);
      expect(step.log_excerpt).toContain('Skipping ffmpeg');
      expect(step.log_excerpt).not.toContain('-max_muxing_queue_size');
    } finally {
      db.close();
    }
  }, 300_000);

  it('refuses the conform template before a plugin source is synced, naming the plugins', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'trawlarr-conform-refuse-'));
    const libraryDir = join(workDir, 'library');
    const dataDir = join(workDir, 'data');
    mkdirSync(libraryDir, { recursive: true });
    await runCli(['library', 'add', '--name', 'Movies', '--root', libraryDir, '--data-dir', dataDir]); // prettier-ignore

    const failure = await runCli([
      'flow', 'add', '--name', 'Conform', '--template', 'conform-library', '--data-dir', dataDir,
    ]).then(
      () => null,
      (error: { code?: number; stderr?: string }) => error,
    ); // prettier-ignore
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe(1);
    expect(failure!.stderr).toContain('"tdarr:ffmpegCommandEnsureAudioStream"');
    expect(failure!.stderr).toContain('trawlarr plugin source sync --name tdarr');

    // Nothing stored, which is the whole point: an unresolvable plugin id
    // VALIDATES, so without the refusal this flow would have been accepted.
    const db = openStateDb(dataDir);
    try {
      expect(createFlowRepo(db).list()).toHaveLength(0);
    } finally {
      db.close();
    }
  }, 120_000);

  it('records a file whose flow reaches Fail Flow as NOT converged', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'trawlarr-failflow-e2e-'));
    const libraryDir = join(workDir, 'library');
    const dataDir = join(workDir, 'data');
    mkdirSync(libraryDir, { recursive: true });
    await makeSample(join(libraryDir, 'Sample.mkv'));

    await runCli(['library', 'add', '--name', 'Movies', '--root', libraryDir, '--data-dir', dataDir]); // prettier-ignore
    await runCli(['plugin', 'source', 'add', '--name', 'tdarr', '--path', CORPUS_DIR, '--data-dir', dataDir]); // prettier-ignore
    await runCli(['plugin', 'source', 'sync', '--name', 'tdarr', '--data-dir', dataDir]);

    // The flow only stores because failFlow installed: an unresolvable
    // plugin id would still store, but `tdarr:failFlow` resolving is what
    // makes this a test of the terminal node rather than of a missing one.
    const flowPath = join(workDir, 'flow.json');
    writeFileSync(flowPath, JSON.stringify(failFlowFlow), 'utf8');
    await runCli(['flow', 'add', '--name', 'Bail', '--file', flowPath, '--data-dir', dataDir]);
    await runCli(['library', 'set-flow', '--library', 'Movies', '--flow', 'Bail', '--data-dir', dataDir]); // prettier-ignore
    await runCli(['scan', '--library', 'Movies', '--data-dir', dataDir]);
    await runCli(['run', '--library', 'Movies', '--data-dir', dataDir]);

    const db = openStateDb(dataDir);
    try {
      const library = createLibraryRepo(db).getByName('Movies')!;
      const mediaFiles = createMediaFileRepo(db);
      const counts = mediaFiles.countsByState(library.id);

      // THE PROPERTY: reaching a node that exists to fail is a failure. A
      // terminal node ends the flow, and "the flow ended" is otherwise how a
      // converged run finishes — which is exactly how an ffmpeg failure once
      // got stored as success.
      expect(counts.good).toBe(0);
      expect(counts.held).toBe(1);

      const row = mediaFiles.listByLibrary({ libraryId: library.id })[0]!;
      const ledger = mediaFiles.getLedger(row.id)!;
      expect(ledger.state).toBe('held');
      expect(ledger.attemptCount).toBe(1);
      // Nothing was ever stamped good, so no signature can match later.
      expect(ledger.signature).toBeNull();
      expect(isKnownGood(ledger, 'any-signature')).toBe(false);
    } finally {
      db.close();
    }
  }, 300_000);
});
