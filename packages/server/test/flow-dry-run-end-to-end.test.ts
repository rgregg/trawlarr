import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DAEMON_LOCK_FILENAME, type DaemonRecord } from '../src/daemon/lockfile.js';
import { ffmpegAvailableSync } from '../../../test-support/tool-availability.js';

const execFileAsync = promisify(execFile);

/**
 * THE PROMISE OF A LIBRARY DRY RUN: it reports exactly the outcomes a
 * definition change swaps, and it touches NOTHING — not a byte on disk, not a
 * row in the database — while it does. This is the only suite that proves
 * that promise against a real daemon, real ffmpeg/ffprobe, and generated
 * media, rather than against a fake `dryRunFlow`.
 *
 * Modelled on `packages/server/test/daemon-end-to-end.test.ts`: a real
 * `node dist/cli.js daemon` process, configured and observed only through its
 * own HTTP API. Deliberately never sets a worker schedule — with no workers
 * running, the two scanned files sit `queued` for the whole test, which is
 * what makes "unchanged after the dry run" a claim about the dry run rather
 * than a coincidence of timing.
 */

// Computed synchronously at module scope: `describe.runIf` reads this at
// collection time, before an async `beforeAll` could run, and a check that
// lived behind one has silently skipped a whole suite in this repo before.
// `ffmpegAvailableSync` throws for anything other than a genuine ENOENT, so
// an unreliable check fails loudly instead of quietly skipping this suite.
const available = ffmpegAvailableSync();

const CLI_PATH = join(process.cwd(), 'packages/server/dist/cli.js');
// Engine too: the walk itself is engine code the daemon runs from its dist.
const SOURCE_DIRS = ['packages/server/src', 'packages/engine/src'];

/** Newest mtime of any file under `dir`, recursively. */
const newestMtimeMs = (dir: string): number => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs);
  }
  return newest;
};

/**
 * This suite spawns a BUILT artifact, so a server- or engine-side regression
 * is invisible here unless `pnpm build` (or `tsc --build --force`) ran first.
 */
const assertBuiltCliIsFresh = (): void => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`${CLI_PATH} does not exist. Run "pnpm build" before this suite.`);
  }
  const builtAt = statSync(CLI_PATH).mtimeMs;
  for (const dir of SOURCE_DIRS) {
    const newestSource = newestMtimeMs(join(process.cwd(), dir));
    if (builtAt < newestSource) {
      throw new Error(
        `${CLI_PATH} (built ${new Date(builtAt).toISOString()}) is older than the newest file ` +
          `under ${dir} (${new Date(newestSource).toISOString()}) — this suite would ` +
          `be exercising STALE compiled output. Run "pnpm build" first.`,
      );
    }
  }
};

/**
 * Waits for a condition about OBSERVABLE state, with a deadline that exists
 * only to turn a hang into a named failure — never an assertion about speed.
 */
const until = async (
  what: string,
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; describe?: () => Promise<string> | string } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      const detail =
        options.describe === undefined ? '' : `\nLast seen: ${await options.describe()}`;
      throw new Error(
        `Timed out after ${String(timeoutMs)}ms waiting for: ${what}.${detail}\n` +
          `(The deadline is a hang detector, not an expectation about speed.)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const makeH264Sample = (path: string) =>
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
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    path,
  ]);

const makeHevcSample = (path: string) =>
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
    'libx265',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    path,
  ]);

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

const md5Of = (path: string): string => createHash('md5').update(readFileSync(path)).digest('hex');

/**
 * The real transcode-and-replace flow used by the other end-to-end suites,
 * parameterised on the codec "Check Video Codec" targets — the one input the
 * canvas in this suite changes. `hevc` is the published flow (the h264 file
 * needs a transcode, the hevc file does not); `h264` is the canvas (the
 * roles swap).
 */
const transcodeFlow = (checkCodec: string): FlowDefinition => ({
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'check',
      pluginId: 'trawlarr:checkVideoCodec',
      pluginVersion: '1.0.0',
      inputs: { codec: checkCodec },
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
});

interface MediaFileSnapshotRow {
  id: string;
  path: string;
  state: string;
  content_key: string;
  size_bytes: number;
  video_codec: string | null;
  updated_at: number;
}

/** Every column that matters for "the dry run left this row exactly alone". */
const snapshotMediaFile = (dataDir: string): MediaFileSnapshotRow[] => {
  const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
  migrate(db);
  const rows = db
    .prepare(
      `SELECT id, path, state, content_key, size_bytes, video_codec, updated_at
       FROM media_file ORDER BY path`,
    )
    .all() as MediaFileSnapshotRow[];
  db.close();
  return rows;
};

interface DryRunOutcomeBody {
  kind: string;
  detail?: string;
}

interface DryRunViewBody {
  status: string;
  processed: number;
  total: number;
  definitionHash: string;
  publishedHash: string;
  counts: Record<string, number>;
  changes: Array<{
    from: DryRunOutcomeBody;
    to: DryRunOutcomeBody;
    files: Array<{ fileId: string; path: string }>;
  }>;
}

interface DryRunDetailBody {
  fileId: string;
  path: string;
  outcome: DryRunOutcomeBody;
  publishedOutcome: DryRunOutcomeBody;
  canvas: { plannedCommands: string[][] } | null;
  published: { plannedCommands: string[][] } | null;
}

describe.runIf(available)(
  'library dry run end-to-end: reports exactly the outcomes a definition change swaps',
  () => {
    let daemon: ChildProcess | null = null;
    let daemonOutput = '';

    afterEach(async () => {
      if (daemon !== null && daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill('SIGKILL');
        await new Promise((resolve) => daemon?.once('exit', resolve));
      }
      daemon = null;
    });

    it("swaps the two files' outcomes and leaves their bytes and rows untouched", async () => {
      assertBuiltCliIsFresh();

      const workDir = mkdtempSync(join(tmpdir(), 'trawlarr-dry-run-e2e-'));
      const libraryRoot = join(workDir, 'library');
      const dataDir = join(workDir, 'data');
      mkdirSync(libraryRoot, { recursive: true });
      mkdirSync(dataDir, { recursive: true });

      const h264Path = join(libraryRoot, 'already-h264.mkv');
      const hevcPath = join(libraryRoot, 'already-hevc.mkv');
      await Promise.all([makeH264Sample(h264Path), makeHevcSample(hevcPath)]);
      expect(await videoCodecOf(h264Path)).toBe('h264');
      expect(await videoCodecOf(hevcPath)).toBe('hevc');

      daemon = spawn('node', [CLI_PATH, 'daemon', '--data-dir', dataDir, '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      daemon.stdout?.setEncoding('utf8');
      daemon.stderr?.setEncoding('utf8');
      daemon.stdout?.on('data', (chunk: string) => {
        daemonOutput += chunk;
      });
      daemon.stderr?.on('data', (chunk: string) => {
        daemonOutput += chunk;
      });

      const lockPath = join(dataDir, DAEMON_LOCK_FILENAME);
      let record: DaemonRecord | null = null;
      await until(
        `the daemon to advertise itself in ${lockPath}`,
        () => {
          if (daemon?.exitCode !== null) {
            throw new Error(
              `The daemon exited with code ${String(daemon?.exitCode)} instead of starting. ` +
                `Its output was:\n${daemonOutput}`,
            );
          }
          if (!existsSync(lockPath)) return false;
          try {
            record = JSON.parse(readFileSync(lockPath, 'utf8')) as DaemonRecord;
          } catch {
            return false;
          }
          return typeof record.port === 'number' && record.port > 0;
        },
        { timeoutMs: 30_000, describe: () => daemonOutput },
      );
      const { port, apiKey } = record!;

      const base = `http://127.0.0.1:${String(port)}/api/v1`;
      const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`${method} ${path} -> ${String(response.status)}: ${text}`);
        }
        return (text === '' ? null : JSON.parse(text)) as T;
      };

      try {
        // Never sets a worker schedule: with no workers claiming anything,
        // the two files sit `queued` for the rest of the test, which is
        // what makes "the dry run changed nothing" a fact about the dry
        // run rather than an accident of timing against a real worker.
        const flow = await api<{ id: string }>('POST', '/flows', {
          name: 'HEVC',
          definition: transcodeFlow('hevc'),
        });
        const library = await api<{ id: string }>('POST', '/libraries', {
          name: 'Movies',
          roots: [libraryRoot],
        });
        await api('PATCH', `/libraries/${library.id}`, { flowId: flow.id });

        await api('POST', `/libraries/${library.id}/scan`);
        await until(
          'the scan to discover and probe both files',
          async () => {
            const files = await api<{ total: number; items: { videoCodec: string | null }[] }>(
              'GET',
              `/files?libraryId=${library.id}&limit=10`,
            );
            return files.total === 2 && files.items.every((file) => file.videoCodec !== null);
          },
          {
            describe: async () =>
              JSON.stringify(await api('GET', `/files?libraryId=${library.id}&limit=10`)),
          },
        );

        const filesAfterScan = await api<{ items: { id: string; path: string }[] }>(
          'GET',
          `/files?libraryId=${library.id}&limit=10`,
        );
        const h264File = filesAfterScan.items.find((file) => file.path === h264Path)!;
        const hevcFile = filesAfterScan.items.find((file) => file.path === hevcPath)!;
        expect(h264File).toBeDefined();
        expect(hevcFile).toBeDefined();

        // Snapshot BEFORE the dry run: bytes and the exact rows the scan wrote.
        const md5H264Before = md5Of(h264Path);
        const md5HevcBefore = md5Of(hevcPath);
        const rowsBefore = snapshotMediaFile(dataDir);

        // The canvas: the same flow, but "Check Video Codec" targets h264
        // instead of hevc — the roles of the two files swap.
        const started = await api<{ runId: string }>('POST', `/flows/${flow.id}/dry-runs`, {
          definition: transcodeFlow('h264'),
        });

        let run: DryRunViewBody;
        await until(
          'the library dry run to finish',
          async () => {
            run = await api<DryRunViewBody>('GET', `/flows/${flow.id}/dry-runs/${started.runId}`);
            return run.status !== 'running';
          },
          { timeoutMs: 30_000 },
        );
        run = await api<DryRunViewBody>('GET', `/flows/${flow.id}/dry-runs/${started.runId}`);

        expect(run.status).toBe('done');
        // The poll carries summaries, never a row per library file.
        expect(run).not.toHaveProperty('files');
        expect(run.processed).toBe(2);
        expect(run.total).toBe(2);
        expect(run.counts).toEqual({ 'no-change': 1, 'change:video': 1 });

        // Exactly two change groups: the h264 file went change:video ->
        // no-change, and the hevc file went the other way.
        expect(run.changes).toHaveLength(2);
        const h264Group = run.changes.find((group) =>
          group.files.some((file) => file.fileId === h264File.id),
        );
        const hevcGroup = run.changes.find((group) =>
          group.files.some((file) => file.fileId === hevcFile.id),
        );
        expect(h264Group).toBeDefined();
        expect(hevcGroup).toBeDefined();
        expect(h264Group).not.toBe(hevcGroup);

        expect(h264Group!.from).toEqual({ kind: 'change', detail: 'video' });
        expect(h264Group!.to).toEqual({ kind: 'no-change' });
        expect(h264Group!.files).toEqual([{ fileId: h264File.id, path: h264Path }]);

        expect(hevcGroup!.from).toEqual({ kind: 'no-change' });
        expect(hevcGroup!.to).toEqual({ kind: 'change', detail: 'video' });
        expect(hevcGroup!.files).toEqual([{ fileId: hevcFile.id, path: hevcPath }]);

        // The hevc file's canvas half: exactly one planned ffmpeg command,
        // and it carries the encoder the flow sets.
        const hevcDetail = await api<DryRunDetailBody>(
          'GET',
          `/flows/${flow.id}/dry-runs/${started.runId}/files/${hevcFile.id}`,
        );
        expect(hevcDetail.outcome).toEqual({ kind: 'change', detail: 'video' });
        expect(hevcDetail.publishedOutcome).toEqual({ kind: 'no-change' });
        expect(hevcDetail.canvas).not.toBeNull();
        expect(hevcDetail.canvas!.plannedCommands).toHaveLength(1);
        expect(hevcDetail.canvas!.plannedCommands[0]!.join(' ')).toContain('libx265');

        // THE POINT OF THIS TASK: nothing on disk and nothing in the
        // database moved while the dry run answered all of the above.
        expect(md5Of(h264Path)).toBe(md5H264Before);
        expect(md5Of(hevcPath)).toBe(md5HevcBefore);
        expect(await videoCodecOf(h264Path)).toBe('h264');
        expect(await videoCodecOf(hevcPath)).toBe('hevc');
        expect(snapshotMediaFile(dataDir)).toEqual(rowsBefore);
      } finally {
        // no-op; daemon cleaned up in afterEach
      }
    }, 60_000);
  },
);
