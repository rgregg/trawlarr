import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createFlowRepo } from '../src/db/flow-repo.js';
import { createLibraryRepo } from '../src/db/library-repo.js';
import { createMediaFileRepo } from '../src/db/media-file-repo.js';
import { createSettingsRepo } from '../src/db/settings-repo.js';
import { createEventBus } from '../src/daemon/events.js';
import { createSupervisor } from '../src/daemon/supervisor.js';
import { createAgentHandle, forkAgent } from '../src/worker/agent-handle.js';
import { scanLibrary } from '../src/scanner/scan-library.js';
import { ffmpegAvailableSync } from '../../../test-support/tool-availability.js';

const execFileAsync = promisify(execFile);

/**
 * A REPORT THAT WAS ALREADY IN THE CHANNEL WHEN THE WORKER WAS SEEN TO EXIT.
 *
 * The daemon learns two things about a worker over two different handles:
 * that the process has gone (`'exit'`), and what it wrote before going (the
 * IPC channel). The event loop is free to service those in either order, and
 * the agent's own `sendAndExit` only guarantees the report has been WRITTEN —
 * into a pipe the daemon may not have read yet. So "the child exited" is not
 * the same fact as "the child reported nothing", and treating it as such
 * throws away the report of a run that fully succeeded.
 *
 * WHAT THAT COSTS, which is why this suite exists rather than a unit test
 * about promise settling. `Replace Original File` has already swapped the
 * transcoded file into place by the time the agent reports. Discard the
 * report and the daemon records a failed attempt instead: the row is backed
 * off and keeps the PRE-transcode identity, while the file on disk carries
 * the post-transcode one. Now nothing is `running` and no row claims those
 * bytes — so the next scan's observation is perfectly current, the
 * in-flight-output guard has nothing to match, and `upsertScanned` opens a
 * SECOND row for a file that is already tracked. Both are then worked: the
 * ghost converges on its own, and when the backoff expires the original row
 * re-runs the flow against its stale probe and transcodes an already-hevc
 * file a second time, pushing the good result into trash. On a real library
 * that is a duplicate encode and a generational loss per affected file.
 *
 * NOTHING HERE IS SIMULATED. A real `fork` of the built agent runs the real
 * flow with real ffmpeg and performs the real replacement; the report is the
 * real one it writes. The ONLY thing this test does is force the ordering in
 * which the daemon observes two events it already receives — the exit before
 * the message the kernel had not handed it yet — which is exactly the
 * interleaving a loaded machine produces on its own a few times in a hundred
 * runs, and which no test that merely runs the two and hopes could pin. The
 * assertions are on observable state only: rows, identity keys, ledger
 * states, the codec on disk.
 */

const available = ffmpegAvailableSync();

/** The agent is forked from its BUILT output, exactly as the daemon forks it. */
const AGENT_PATH = join(process.cwd(), 'packages/server/dist/worker/agent.js');
const SERVER_DIST = join(process.cwd(), 'packages/server/dist');
const SERVER_SRC = join(process.cwd(), 'packages/server/src');

const newestMtimeMs = (dir: string): number => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs);
  }
  return newest;
};

/**
 * Deliberately NOT gated on `existsSync`: a missing or stale build must FAIL
 * loudly rather than skip, or a regression in `src/` would be invisible here.
 */
const assertBuiltAgentIsFresh = (): void => {
  if (!existsSync(AGENT_PATH)) {
    throw new Error(`${AGENT_PATH} does not exist. Run "pnpm build" before this suite.`);
  }
  // The whole output tree, not `agent.js` alone: `tsc --build` is
  // incremental and rewrites only what changed, so an unmodified agent keeps
  // its old mtime across a perfectly fresh build of everything around it.
  if (newestMtimeMs(SERVER_DIST) < newestMtimeMs(SERVER_SRC)) {
    throw new Error(
      `${AGENT_PATH} is older than the newest file under packages/server/src — this suite ` +
        `would be forking STALE compiled output. Run "pnpm build" (or "tsc --build --force").`,
    );
  }
};

const makeSample = (path: string) =>
  execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      path,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );

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

const TRANSCODE_FLOW: FlowDefinition = {
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
};

/**
 * A REAL forked agent, whose two endings reach the daemon in the dangerous
 * order.
 *
 * The child is the genuine article — same `forkAgent`, same detached process
 * group, same IPC protocol, running the real flow. This wrapper only decides
 * WHEN the daemon sees each event it was going to see anyway:
 *
 *   1. the terminal message (`done`/`failed`) is held back;
 *   2. `'exit'` is delivered first, which is the observation that used to be
 *      taken as proof that nothing was reported;
 *   3. then the held report, still in the channel, exactly as the kernel
 *      would hand it over on the next read;
 *   4. then `'disconnect'`, which is EOF on that channel and the only event
 *      that can honestly mean "nothing more is coming".
 *
 * Every other message (`ready`, `step`, `heartbeat`, `progress`, `log`) is
 * forwarded untouched and immediately — the job could not even start
 * otherwise, since the daemon sends it in response to `ready`.
 */
const forkWithExitBeforeReport = (): {
  fork: (modulePath: string) => ChildProcess;
  /** Whether the forced ordering actually happened, so a passing test cannot be vacuous. */
  ordering: () => string[];
} => {
  const ordering: string[] = [];

  const fork = (modulePath: string): ChildProcess => {
    // `createAgentHandle` asks for the agent that sits beside ITSELF, which
    // under vitest is the TypeScript source. Production resolves the same
    // relative path inside `dist`, so this seam substitutes exactly what a
    // deployed daemon would have forked, and asserts the two are the same
    // module rather than quietly forking something else.
    expect(modulePath.replace('/src/', '/dist/')).toBe(AGENT_PATH);
    const child = forkAgent(AGENT_PATH);
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const emit = (event: string, ...args: unknown[]): void => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    };

    let terminal: unknown = null;
    let exitDelivered = false;
    let realDisconnected = false;

    const pump = (): void => {
      if (!exitDelivered) return;
      if (terminal !== null) {
        const message = terminal;
        terminal = null;
        ordering.push('report');
        emit('message', message);
      }
      if (realDisconnected) {
        ordering.push('disconnect');
        emit('disconnect');
      }
    };

    child.on('message', (raw: unknown) => {
      const type = (raw as { type?: unknown } | null)?.type;
      if (type === 'done' || type === 'failed') {
        terminal = raw;
        pump();
        return;
      }
      emit('message', raw);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      exitDelivered = true;
      ordering.push('exit');
      emit('exit', code, signal);
      pump();
    });
    child.on('disconnect', () => {
      realDisconnected = true;
      pump();
    });
    child.on('error', (error: Error) => {
      emit('error', error);
    });

    const facade = {
      get pid() {
        return child.pid;
      },
      get connected() {
        return child.connected;
      },
      get stdout() {
        return child.stdout;
      },
      get stderr() {
        return child.stderr;
      },
      send: (message: unknown) => child.send(message as never),
      kill: (signal?: NodeJS.Signals) => child.kill(signal),
      disconnect: () => {
        child.disconnect();
      },
      on: (event: string, fn: (...args: unknown[]) => void) => {
        const existing = listeners.get(event);
        if (existing === undefined) listeners.set(event, [fn]);
        else existing.push(fn);
        return facade;
      },
    };
    return facade as unknown as ChildProcess;
  };

  return { fork, ordering: () => ordering };
};

const NOW = 1_700_000_000_000;

const rows = (db: Db): { id: string; path: string; state: string; content_key: string }[] =>
  db
    .prepare(`SELECT id, path, state, content_key FROM media_file ORDER BY discovered_at`)
    .all() as {
    id: string;
    path: string;
    state: string;
    content_key: string;
  }[];

/**
 * Everything up to and including the moment the daemon has folded the run:
 * a real library, a real h264 file, a real forked agent that really
 * transcodes and really replaces it, and the exit observed before the report.
 */
const runOneJobWithExitBeforeReport = async (): Promise<{
  db: Db;
  libraryId: string;
  filePath: string;
  libraryRoot: string;
  originalRow: { id: string; content_key: string };
  ordering: string[];
  close: () => Promise<void>;
}> => {
  assertBuiltAgentIsFresh();

  const workDir = mkdtempSync(join(tmpdir(), 'trawlarr-exit-report-'));
  const libraryRoot = join(workDir, 'library');
  const dataDir = join(workDir, 'data');
  mkdirSync(libraryRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const filePath = join(libraryRoot, 'movie.mkv');
  await makeSample(filePath);
  expect(await videoCodecOf(filePath)).toBe('h264');

  const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
  migrate(db);

  const settings = createSettingsRepo({ db });
  settings.setHardware({ available: ['cpu'], caps: {} });
  settings.setSchedule({ timezone: 'UTC', baseCounts: { transcode: 1, health: 0 }, windows: [] });

  const flow = createFlowRepo(db).create({ name: 'HEVC', definition: TRANSCODE_FLOW, nowMs: NOW });
  const library = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [libraryRoot],
    extensions: ['mkv'],
    flowId: flow.id,
    nowMs: NOW,
  });

  const firstScan = await scanLibrary({
    db,
    libraryId: library.id,
    ffprobePath: 'ffprobe',
    nowMs: () => NOW,
  });
  expect(firstScan.added).toBe(1);
  expect(firstScan.queued).toBe(1);
  const originalRow = rows(db)[0]!;

  const forced = forkWithExitBeforeReport();
  const supervisor = createSupervisor({
    db,
    bus: createEventBus(),
    settings,
    nowMs: () => Date.now(),
    dataDir,
    // Production's own wiring, with production's own documented fork seam
    // pointed at the built agent and the two endings reordered.
    createAgent: (factoryInput) =>
      createAgentHandle({
        id: factoryInput.id,
        documents: factoryInput.documents,
        onStep: factoryInput.onStep,
        onHeartbeat: factoryInput.onHeartbeat,
        onProgress: factoryInput.onProgress,
        onLog: factoryInput.onLog,
        nowMs: factoryInput.nowMs,
        forkFn: forced.fork,
      }),
  });

  await supervisor.tick();
  await supervisor.drain();

  // The interleaving really was forced, and the run really happened. Without
  // both of these a green test could mean nothing more than "the ordering
  // happened to be the safe one" or "no transcode took place at all".
  expect(forced.ordering()).toEqual(['exit', 'report', 'disconnect']);
  expect(await videoCodecOf(filePath)).toBe('hevc');

  return {
    db,
    libraryId: library.id,
    filePath,
    libraryRoot,
    originalRow,
    ordering: forced.ordering(),
    close: async () => {
      await supervisor.stop();
      db.close();
    },
  };
};

describe.runIf(available)('a worker whose report the daemon saw after its exit', () => {
  it('records the run the worker reported, instead of counting a finished transcode as a failure', async () => {
    const { db, originalRow, close } = await runOneJobWithExitBeforeReport();
    try {
      // THE REPORT WAS NOT DISCARDED.
      const jobs = db.prepare(`SELECT state FROM job`).all() as { state: string }[];
      expect(jobs.map((job) => job.state)).toEqual(['succeeded']);

      // And the row that owns the file carries the REPLACEMENT's identity,
      // not the pre-transcode one a stalled attempt would have left on it —
      // which is the stale identity that lets a later scan fork the file.
      const afterRun = rows(db);
      expect(afterRun).toHaveLength(1);
      expect(afterRun[0]?.id).toBe(originalRow.id);
      expect(afterRun[0]?.state).toBe('good');
      expect(afterRun[0]?.content_key).not.toBe(originalRow.content_key);

      // Nothing is waiting out a backoff to transcode the already-hevc file
      // a second time.
      expect(
        createMediaFileRepo(db).claimNext({ workerClass: 'transcode', nowMs: Date.now() }),
      ).toBeNull();
    } finally {
      await close();
    }
  }, 600_000);

  it('leaves a real scan of the replaced file with nothing new to add — no ghost row', async () => {
    const { db, libraryId, libraryRoot, originalRow, close } =
      await runOneJobWithExitBeforeReport();
    try {
      const rescan = await scanLibrary({
        db,
        libraryId,
        ffprobePath: 'ffprobe',
        nowMs: () => NOW,
      });

      // EXACTLY ONE ROW describes this file, and it is the row that ran it.
      const afterRescan = rows(db);
      expect(afterRescan).toHaveLength(1);
      expect(afterRescan[0]?.id).toBe(originalRow.id);
      expect(afterRescan[0]?.state).toBe('good');
      expect(rescan.added).toBe(0);
      expect(rescan.queued).toBe(0);
      expect(rescan.alreadyGood).toBe(1);

      // Nothing is claimable: no ghost row to converge on its own, and no
      // backed-off original to re-encode what is already encoded.
      expect(
        createMediaFileRepo(db).claimNext({ workerClass: 'transcode', nowMs: Date.now() }),
      ).toBeNull();

      // One original in trash, not two: the file was encoded exactly once.
      expect(readdirSync(join(libraryRoot, '.trawlarr', 'trash'))).toHaveLength(1);
    } finally {
      await close();
    }
  }, 600_000);
});
