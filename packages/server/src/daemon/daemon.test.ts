import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractFacts, type FactSet, type FlowDefinition } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { createSettingsRepo } from '../db/settings-repo.js';
import { migrate, SCHEMA_VERSION } from '../db/migrate.js';
import { AgentFailure, type AgentHandle } from '../worker/agent-handle.js';
import type { JobPayload } from '../worker/job-payload.js';
import type { JobReport } from '../worker/run-payload.js';
import { startDaemon, type Daemon } from './daemon.js';
import {
  DAEMON_LOCK_FILENAME,
  DaemonAlreadyRunningError,
  readDaemonRecord,
  type DaemonRecord,
} from './lockfile.js';
import type { CreateAgentFn } from './supervisor.js';
import type { WatchHandle, WatchPort } from './watcher.js';

const NOW = Date.UTC(2024, 0, 1, 0, 30);

const PROBE: ProbeData = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '60.0', size: '4096', bit_rate: '16384' },
};
const FACTS: FactSet = extractFacts({ probe: PROBE, container: 'mkv', sizeBytes: 4096 });

const VALID_FLOW: FlowDefinition = {
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
};

const newDataDir = (): string => mkdtempSync(join(tmpdir(), 'trawlarr-daemon-'));

/** A watch port that watches nothing: chokidar is exercised by `watcher.test.ts`. */
const nullWatchPort: WatchPort = {
  watch: (): WatchHandle => ({ close: async (): Promise<void> => {} }),
};

const openDataDb = (dataDir: string): Db => openDatabase({ file: join(dataDir, 'trawlarr.db') });

/**
 * Stamp the data directory's database with a schema version this build does
 * not know, exactly as a NEWER trawlarr would have left it.
 */
const writeFutureSchemaVersion = (dataDir: string): void => {
  const db = openDataDb(dataDir);
  migrate(db);
  db.prepare(`UPDATE setting SET value = ? WHERE key = 'schema_version'`).run(
    String(SCHEMA_VERSION + 1),
  );
  db.close();
};

/** A pid that certainly does not exist: a real child, waited for. */
const deadPid = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const child = execFile(process.execPath, ['-e', ''], (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(child.pid!);
    });
  });

interface SeededLibrary {
  libraryId: string;
  fileId: string;
  root: string;
}

/** A library with one queued, probed file, written before any daemon starts. */
const seedLibrary = (dataDir: string, options?: { deleteFlow?: boolean }): SeededLibrary => {
  const db = openDataDb(dataDir);
  migrate(db);
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-daemon-root-'));
  const flow = createFlowRepo(db).create({ name: 'Flow', definition: VALID_FLOW, nowMs: NOW });
  const library = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    flowId: flow.id,
    nowMs: NOW,
  });
  const mediaFileRepo = createMediaFileRepo(db);
  const fileId = mediaFileRepo.upsertScanned({
    libraryId: library.id,
    identity: { inodeKey: '2049:1000', contentKey: '4096:1:ff' },
    path: join(root, 'file.mkv'),
    nlink: 1,
    sizeBytes: 4096,
    mtimeMs: NOW,
    ctimeMs: NOW,
    container: 'mkv',
    nowMs: NOW,
  });
  mediaFileRepo.setProbe({ fileId, probe: PROBE, facts: FACTS });
  mediaFileRepo.setState({ fileId, state: 'queued' });
  // The library keeps pointing at a flow row that is gone — what a deleted
  // flow leaves behind, and something `flowRepo.create` (which validates)
  // cannot be made to store.
  if (options?.deleteFlow === true) db.prepare(`DELETE FROM flow WHERE id = ?`).run(flow.id);
  db.close();
  return { libraryId: library.id, fileId, root };
};

const rowFor = (dataDir: string, fileId: string): MediaFileRow => {
  const db = openDataDb(dataDir);
  const row = db.prepare(`SELECT * FROM media_file WHERE id = ?`).get(fileId) as MediaFileRow;
  db.close();
  return row;
};

const libraryRow = (dataDir: string): { enabled: number; paused_reason: string | null } => {
  const db = openDataDb(dataDir);
  const row = db.prepare(`SELECT enabled, paused_reason FROM library`).get() as {
    enabled: number;
    paused_reason: string | null;
  };
  db.close();
  return row;
};

/**
 * A worker that never becomes a process, and never finishes on its own.
 *
 * `cancel()` settles it the way a real cancelled agent settles — that is the
 * behaviour under test: a daemon whose drain deadline passes must CANCEL,
 * and a cancel that nothing acted on would hang the shutdown for ever.
 */
interface FakeAgent {
  readonly cancelled: boolean;
  readonly payload: JobPayload | null;
}

const fakeAgents = (): { agents: FakeAgent[]; createAgent: CreateAgentFn } => {
  const agents: FakeAgent[] = [];
  const createAgent: CreateAgentFn = () => {
    let cancelled = false;
    let payload: JobPayload | null = null;
    let settle: { reject: (error: unknown) => void } | null = null;

    const agent: FakeAgent & AgentHandle = {
      id: 'fake',
      pid: undefined,
      exited: Promise.resolve(0),
      get cancelled() {
        return cancelled;
      },
      get payload() {
        return payload;
      },
      run: (given: JobPayload) => {
        payload = given;
        return new Promise<JobReport>((_resolve, reject) => {
          settle = { reject };
        });
      },
      cancel: () => {
        cancelled = true;
        settle?.reject(new AgentFailure('cancelled', { reported: false, cancelled: true }));
      },
      kill: () => {},
    };
    agents.push(agent);
    return agent;
  };
  return { agents, createAgent };
};

/**
 * A stand-in ffmpeg that LISTS `hevc_nvenc` — as Debian's real one does on a
 * machine with no GPU at all — and either can or cannot actually encode with
 * it. That asymmetry is the whole point of the preflight.
 */
const fakeNvencFfmpeg = (options: { encodeWorks: boolean }): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'trawlarr-fake-ffmpeg-')), 'ffmpeg');
  writeFileSync(
    path,
    `#!/bin/sh\n` +
      `case "$*" in\n` +
      `  *-encoders*)\n` +
      `    echo " V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)"\n` +
      `    exit 0;;\n` +
      `esac\n` +
      `exit ${options.encodeWorks ? '0' : '1'}\n`,
    'utf8',
  );
  chmodSync(path, 0o755);
  return path;
};

/** Declare hardware and an ffmpeg before any daemon starts, as the env seeds would. */
const seedHardware = (dataDir: string, ffmpeg: string): void => {
  const db = openDataDb(dataDir);
  migrate(db);
  const settings = createSettingsRepo({ db });
  settings.setHardware({ available: ['cpu', 'nvenc'], caps: { nvenc: 2 } });
  settings.setBinaries({ ffmpeg });
  db.close();
};

const versionBody = async (dataDir: string, port: number): Promise<Record<string, unknown>> => {
  const record = (await readDaemonRecord({ dataDir }))!;
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/system/version`, {
    headers: { 'x-api-key': record.apiKey },
  });
  return (await response.json()) as Record<string, unknown>;
};

const running: Daemon[] = [];

const start = async (input: Parameters<typeof startDaemon>[0]): Promise<Daemon> => {
  const daemon = await startDaemon({
    port: 0,
    installSignalHandlers: false,
    // Shutdown must never wait on a fake worker that has no intention of
    // finishing; the deadline's own behaviour has a test of its own below.
    drainDeadlineMs: 0,
    watchPort: nullWatchPort,
    onError: () => {},
    ...input,
  });
  running.push(daemon);
  return daemon;
};

afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

const health = async (port: number): Promise<Response> =>
  await fetch(`http://127.0.0.1:${String(port)}/api/v1/system/health`);

describe('startDaemon', () => {
  it('starts, serves the API on the recorded port, and stops cleanly', async () => {
    const dataDir = newDataDir();
    const daemon = await start({ dataDir });

    const record = (await readDaemonRecord({ dataDir }))!;
    expect(record.port).toBe(daemon.port);
    expect(record.pid).toBe(process.pid);
    expect(record.schemaVersion).toBe(SCHEMA_VERSION);

    expect((await health(daemon.port)).status).toBe(200);

    await daemon.stop();
    expect(await readDaemonRecord({ dataDir })).toBeNull();
    // The socket is really closed, not merely forgotten.
    await expect(health(daemon.port)).rejects.toThrow();
  });

  it('records the api key its API actually requires', async () => {
    const dataDir = newDataDir();
    const daemon = await start({ dataDir });
    const record = (await readDaemonRecord({ dataDir }))!;

    const denied = await fetch(`http://127.0.0.1:${String(daemon.port)}/api/v1/libraries`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`http://127.0.0.1:${String(daemon.port)}/api/v1/libraries`, {
      headers: { 'x-api-key': record.apiKey },
    });
    expect(allowed.status).toBe(200);
  });

  it('refuses to start against a database from a newer schema version, by name', async () => {
    const dataDir = newDataDir();
    writeFutureSchemaVersion(dataDir);
    await expect(start({ dataDir })).rejects.toThrow(/schema version/i);
    // Nothing was left half-started: no lock, so the next (correct) build can start.
    expect(await readDaemonRecord({ dataDir })).toBeNull();
  });

  it('refuses to start beside a live daemon and leaves it serving', async () => {
    const dataDir = newDataDir();
    const first = await start({ dataDir });

    await expect(startDaemon({ dataDir, port: 0, installSignalHandlers: false })).rejects.toThrow(
      DaemonAlreadyRunningError,
    );

    expect((await readDaemonRecord({ dataDir }))!.port).toBe(first.port);
    expect((await health(first.port)).status).toBe(200);
  });

  it('reclaims a claim its previous life stranded, before it claims anything new', async () => {
    // A worker that died having written NOTHING leaves the row `running` and
    // the daemon that forked it is gone too, so nothing in the old process is
    // ever going to settle it. Before this the row waited for the reaper's
    // first interval an hour later — and, on a library that is still being
    // scanned, for ever, because every walk refreshed the row's `updated_at`
    // and the reaper read that as a sign of life.
    //
    // The pid the daemon wrote down is what settles it: a process that is not
    // in this host's table is not encoding anything. A worker that OUTLIVED
    // the daemon has a live pid and is deliberately untouched.
    const dataDir = newDataDir();
    const { fileId } = seedLibrary(dataDir);
    const gone = await deadPid();

    const seed = openDataDb(dataDir);
    createMediaFileRepo(seed).setState({ fileId, state: 'running' });
    const jobId = createJobRepo(seed).start({
      fileId,
      flowId: 'flow',
      flowHash: 'hash',
      nowMs: NOW,
    });
    createJobRepo(seed).heartbeat({ jobId, nowMs: NOW + 181 });
    createJobRepo(seed).setWorker({ jobId, pid: gone, host: hostname() });
    seed.close();

    const { createAgent } = fakeAgents();
    await start({ dataDir, createAgent, nowMs: () => NOW + 60_000 });

    const after = openDataDb(dataDir);
    try {
      expect(createMediaFileRepo(after).getById(fileId)?.state).not.toBe('running');
      expect(createJobRepo(after).getById(jobId)?.endedAt).not.toBeNull();
    } finally {
      after.close();
    }
  });

  it('takes over a data directory whose daemon is gone', async () => {
    const dataDir = newDataDir();
    const stale: DaemonRecord = {
      pid: await deadPid(),
      bind: '127.0.0.1',
      port: 1,
      apiKey: 'stale',
      startedAtMs: NOW,
      schemaVersion: SCHEMA_VERSION,
    };
    writeFileSync(join(dataDir, DAEMON_LOCK_FILENAME), JSON.stringify(stale), 'utf8');

    const daemon = await start({ dataDir });
    const record = (await readDaemonRecord({ dataDir }))!;
    expect(record.pid).toBe(process.pid);
    expect(record.port).toBe(daemon.port);
  });

  it('pauses a library whose flow cannot run before any work is attempted', async () => {
    const dataDir = newDataDir();
    seedLibrary(dataDir, { deleteFlow: true });
    const { agents, createAgent } = fakeAgents();

    await start({ dataDir, createAgent });

    const row = libraryRow(dataDir);
    expect(row.enabled).toBe(0);
    expect(row.paused_reason).toMatch(/^flow-invalid: /);
    // And nothing was claimed: a paused library is never drained.
    expect(agents).toHaveLength(0);
  });

  it('claims queued work as soon as it starts, without waiting for a tick', async () => {
    const dataDir = newDataDir();
    const seeded = seedLibrary(dataDir);
    const { agents, createAgent } = fakeAgents();

    await start({ dataDir, createAgent });
    // The claim is committed before the fork, so the row is `running` in the
    // database by the time the agent exists.
    expect(agents).toHaveLength(1);
    expect(agents[0]!.payload!.fileId).toBe(seeded.fileId);
    expect(rowFor(dataDir, seeded.fileId).state).toBe('running');
  });

  it('cancels a worker still running when the drain deadline passes, and leaves no claimed row', async () => {
    const dataDir = newDataDir();
    const seeded = seedLibrary(dataDir);
    const { agents, createAgent } = fakeAgents();

    const daemon = await start({ dataDir, createAgent, drainDeadlineMs: 0 });
    expect(agents).toHaveLength(1);

    await daemon.stop();

    // The observable consequences of an orderly shutdown: the worker was
    // cancelled (which is what signals its whole process group, and so the
    // ffmpeg it may have spawned), and its file is back in the queue rather
    // than stranded `running` with no worker left to finish it.
    expect(agents[0]!.cancelled).toBe(true);
    expect(rowFor(dataDir, seeded.fileId).state).toBe('queued');
    expect(await readDaemonRecord({ dataDir })).toBeNull();
  });

  it('reports the api key as generated only on the first start', async () => {
    const dataDir = newDataDir();
    const first = await start({ dataDir });
    expect(first.apiKeyGenerated).toBe(true);
    await first.stop();

    const second = await start({ dataDir });
    expect(second.apiKeyGenerated).toBe(false);
    expect(second.apiKey).toBe(first.apiKey);
  });

  it('persists a --port override but never a kernel-assigned one', async () => {
    const dataDir = newDataDir();
    const daemon = await start({ dataDir });
    await daemon.stop();

    const db = openDataDb(dataDir);
    const row = db.prepare(`SELECT value FROM setting WHERE key = 'daemon.port'`).get() as
      { value: string } | undefined;
    db.close();
    // `--port 0` means "ask the kernel for this run"; storing it would make
    // every later start pick a port nobody configured.
    expect(row?.value).not.toBe('0');
  });

  it('resolves `stopped` once, however many times stop is called', async () => {
    const dataDir = newDataDir();
    const daemon = await start({ dataDir });
    await Promise.all([daemon.stop(), daemon.stop()]);
    await expect(daemon.stopped).resolves.toBeUndefined();
  });
});

describe('the hardware preflight', () => {
  it('reports a declared encoder this machine cannot really run, and changes nothing', async () => {
    const dataDir = newDataDir();
    // A GPU-less host that declares nvenc: the container was started without
    // `runtime: nvidia`, or without NVIDIA_DRIVER_CAPABILITIES=…,video.
    seedHardware(dataDir, fakeNvencFfmpeg({ encodeWorks: false }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const daemon = await start({ dataDir });

    expect((await versionBody(dataDir, daemon.port)).hardware).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
    ]);
    // The declaration is the operator's, and it stands: nothing was rewritten
    // to something trawlarr preferred, and the daemon came up serving.
    const db = openDataDb(dataDir);
    expect(createSettingsRepo({ db }).getHardware()).toEqual({
      available: ['cpu', 'nvenc'],
      caps: { nvenc: 2 },
    });
    db.close();
    expect((await health(daemon.port)).status).toBe(200);
  });

  it('reports nothing when the declared encoder both lists and runs', async () => {
    const dataDir = newDataDir();
    seedHardware(dataDir, fakeNvencFfmpeg({ encodeWorks: true }));

    const daemon = await start({ dataDir });

    expect((await versionBody(dataDir, daemon.port)).hardware).toEqual([]);
  });

  it('starts, and reports the declaration as unproven, when ffmpeg cannot be run at all', async () => {
    const dataDir = newDataDir();
    seedHardware(dataDir, join(tmpdir(), 'trawlarr-no-such-ffmpeg-4f21'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const daemon = await start({ dataDir });

    expect((await versionBody(dataDir, daemon.port)).hardware).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
    ]);
    expect((await health(daemon.port)).status).toBe(200);
  });
});
