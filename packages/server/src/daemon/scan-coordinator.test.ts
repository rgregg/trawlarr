import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { createSettingsRepo } from '../db/settings-repo.js';
import type { ScanLibraryInput, ScanSummary } from '../scanner/scan-library.js';
import { createEventBus, type TrawlarrEvent } from './events.js';
import {
  createScanCoordinator,
  type ScanCoordinator,
  type ScanCoordinatorErrorContext,
  type ScanFn,
  type ScanReason,
} from './scan-coordinator.js';
import type { WatchInput, WatchPort } from './watcher.js';

const SETTLE_MS = 30_000;
const RESCAN_MS = 3_600_000;

const summaryOf = (patch: Partial<ScanSummary> = {}): ScanSummary => ({
  seen: 0,
  added: 0,
  updated: 0,
  queued: 0,
  skippedHardlinked: 0,
  unreadable: 0,
  alreadyGood: 0,
  probed: 0,
  inFlight: 0,
  missing: 0,
  restored: 0,
  rootsUnavailable: 0,
  ...patch,
});

/**
 * Every timer this suite exercises is injected. Nothing here ever sleeps:
 * a 30-second settle and a one-hour rescan are advanced by moving this
 * clock, so the tests state the RULE ("scanned once, after the last event")
 * rather than hoping a real timer beat the assertion.
 */
interface FakeTimers {
  now(): number;
  advance(ms: number): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  armed(): number;
}

const createFakeTimers = (): FakeTimers => {
  const timers = new Map<number, { at: number; fn: () => void }>();
  let clock = 0;
  let nextId = 0;

  return {
    now: () => clock,
    armed: () => timers.size,
    setTimer: (fn, ms) => {
      nextId += 1;
      timers.set(nextId, { at: clock + ms, fn });
      return nextId;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    advance: (ms) => {
      const target = clock + ms;
      for (;;) {
        // Re-read every pass: a timer's callback may arm another one (the
        // periodic rescan re-arms itself), and that one must fire too if it
        // falls inside the window being advanced through.
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
      }
      clock = target;
    },
  };
};

interface ScanCall {
  libraryId: string;
  reason: ScanReason;
}

interface HarnessOptions {
  libraries?: string[];
  settleMs?: number;
  rescanIntervalMs?: number;
  watchEnabled?: boolean;
  summary?: Partial<ScanSummary>;
  /** Scans that throw before doing anything else, counted from the first. */
  failFirst?: number;
  /** Blocking scans: each one waits for `release()`. */
  blocking?: boolean;
  /** Runs inside the fake scan, with the input the coordinator built. */
  duringScan?: (input: ScanLibraryInput & { reason: ScanReason }) => void;
}

interface Harness {
  db: Db;
  bus: ReturnType<typeof createEventBus>;
  coordinator: ScanCoordinator;
  timers: FakeTimers;
  scans: ScanCall[];
  events: TrawlarrEvent[];
  errors: { error: unknown; context: ScanCoordinatorErrorContext }[];
  libraryIds: string[];
  watched: WatchInput[];
  closedWatchers(): number;
  release(): Promise<void>;
}

const harness = (options: HarnessOptions = {}): Harness => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);

  const base = mkdtempSync(join(tmpdir(), 'trawlarr-coord-'));
  const libraryRepo = createLibraryRepo(db);
  const libraryIds = (options.libraries ?? ['lib']).map((name) => {
    const root = join(base, name);
    mkdirSync(root, { recursive: true });
    return libraryRepo.create({ name, roots: [root], nowMs: 0 }).id;
  });

  const settings = createSettingsRepo({ db });
  settings.setScan({
    settleMs: options.settleMs ?? SETTLE_MS,
    rescanIntervalMs: options.rescanIntervalMs ?? RESCAN_MS,
    watchEnabled: options.watchEnabled ?? true,
  });

  const bus = createEventBus();
  const events: TrawlarrEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const timers = createFakeTimers();
  const scans: ScanCall[] = [];
  const errors: { error: unknown; context: ScanCoordinatorErrorContext }[] = [];
  const gates: (() => void)[] = [];
  let released = options.blocking !== true;
  let failuresLeft = options.failFirst ?? 0;

  const scanFn: ScanFn = async (input) => {
    scans.push({ libraryId: input.libraryId, reason: input.reason });
    options.duringScan?.(input);
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('ffprobe vanished');
    }
    if (!released) {
      await new Promise<void>((resolve) => gates.push(resolve));
    }
    return summaryOf(options.summary);
  };

  const watched: WatchInput[] = [];
  let closed = 0;
  const watchPort: WatchPort = {
    watch: (watchInput) => {
      watched.push(watchInput);
      return {
        close: async () => {
          closed += 1;
        },
      };
    },
  };

  const coordinator = createScanCoordinator({
    db,
    bus,
    settings,
    nowMs: () => timers.now(),
    watchPort,
    scanFn,
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (handle) => {
      timers.clearTimer(handle);
    },
    onError: (error, context) => errors.push({ error, context }),
  });

  return {
    db,
    bus,
    coordinator,
    timers,
    scans,
    events,
    errors,
    libraryIds,
    watched,
    closedWatchers: () => closed,
    release: async () => {
      released = true;
      for (const gate of gates.splice(0)) gate();
      await Promise.resolve();
    },
  };
};

describe('scan coordinator: debounce and settle', () => {
  it('coalesces a burst of watch events into one scan', () => {
    const { coordinator, scans, timers, libraryIds } = harness();
    coordinator.start();
    for (let i = 0; i < 10; i += 1) coordinator.request(libraryIds[0]!, 'watch');
    expect(scans).toHaveLength(0);
    timers.advance(SETTLE_MS);
    expect(scans).toEqual([{ libraryId: libraryIds[0], reason: 'watch' }]);
  });

  it('resets the settle timer on each further event, so a long copy is scanned once at the end', () => {
    const { coordinator, scans, timers, libraryIds } = harness();
    coordinator.start();
    coordinator.request(libraryIds[0]!, 'watch');
    timers.advance(29_000);
    coordinator.request(libraryIds[0]!, 'watch');
    timers.advance(29_000);
    expect(scans).toHaveLength(0);
    timers.advance(1_000);
    expect(scans).toHaveLength(1);
  });

  it('does not debounce a manual, startup or interval trigger', () => {
    const { coordinator, scans, libraryIds } = harness();
    coordinator.request(libraryIds[0]!, 'manual');
    expect(scans.map((scan) => scan.reason)).toEqual(['manual']);
  });

  it('lets an explicit trigger supersede a settling burst rather than scanning twice', async () => {
    const { coordinator, scans, timers, libraryIds } = harness();
    coordinator.request(libraryIds[0]!, 'watch');
    coordinator.request(libraryIds[0]!, 'manual');
    await coordinator.idle();
    timers.advance(SETTLE_MS);
    expect(scans.map((scan) => scan.reason)).toEqual(['manual']);
    expect(timers.armed()).toBe(0);
  });
});

describe('scan coordinator: one scan per library', () => {
  it('never runs two scans of one library at once, and re-scans once afterwards if asked during', async () => {
    const { coordinator, scans, release, libraryIds } = harness({ blocking: true });
    coordinator.request(libraryIds[0]!, 'manual');
    await Promise.resolve();
    coordinator.request(libraryIds[0]!, 'watch');
    coordinator.request(libraryIds[0]!, 'watch');
    expect(scans).toHaveLength(1);
    expect(coordinator.scanning()).toEqual([libraryIds[0]]);
    await release();
    await coordinator.idle();
    expect(scans).toHaveLength(2); // exactly one catch-up, not two
    expect(scans[1]!.reason).toBe('watch');
    expect(coordinator.scanning()).toEqual([]);
  });

  it('scans a different library concurrently, since the lock is per library', async () => {
    const { coordinator, scans, libraryIds, release } = harness({
      blocking: true,
      libraries: ['lib-a', 'lib-b'],
    });
    coordinator.request(libraryIds[0]!, 'manual');
    coordinator.request(libraryIds[1]!, 'manual');
    await Promise.resolve();
    expect(scans.map((scan) => scan.libraryId).sort()).toEqual([...libraryIds].sort());
    expect(coordinator.scanning().sort()).toEqual([...libraryIds].sort());
    await release();
    await coordinator.idle();
  });

  it('does not leave a library locked after a scan throws', async () => {
    const { coordinator, scans, errors, libraryIds } = harness({ failFirst: 1 });
    coordinator.request(libraryIds[0]!, 'manual');
    await coordinator.idle();
    expect(errors.map((entry) => entry.context)).toEqual([
      { libraryId: libraryIds[0], phase: 'scan' },
    ]);
    expect(coordinator.scanning()).toEqual([]);

    coordinator.request(libraryIds[0]!, 'manual');
    await coordinator.idle();
    expect(scans).toHaveLength(2);
  });
});

describe('scan coordinator: the periodic rescan', () => {
  it('runs a periodic rescan on the configured interval', () => {
    const { coordinator, scans, timers, libraryIds } = harness({ rescanIntervalMs: RESCAN_MS });
    coordinator.start();
    timers.advance(RESCAN_MS - 1);
    expect(scans).toHaveLength(0);
    timers.advance(1);
    expect(scans).toEqual([{ libraryId: libraryIds[0], reason: 'interval' }]);
  });

  it('keeps rescanning every library after a scan fails: the timer outlives the failure', async () => {
    const { coordinator, scans, errors, timers } = harness({
      libraries: ['lib-a', 'lib-b'],
      failFirst: 2,
    });
    coordinator.start();

    timers.advance(RESCAN_MS);
    await coordinator.idle();
    expect(scans).toHaveLength(2);
    expect(errors).toHaveLength(2);

    // The whole point: an hour later it is still scanning. A rescan that
    // quietly stopped would look exactly like a library with nothing to do.
    timers.advance(RESCAN_MS);
    await coordinator.idle();
    expect(scans.map((scan) => scan.reason)).toEqual([
      'interval',
      'interval',
      'interval',
      'interval',
    ]);
    expect(errors).toHaveLength(2);
  });

  it('re-reads the interval from settings on each cycle, so a change takes effect without a restart', async () => {
    const { coordinator, scans, timers, db } = harness({ rescanIntervalMs: RESCAN_MS });
    coordinator.start();
    timers.advance(RESCAN_MS);
    await coordinator.idle();
    expect(scans).toHaveLength(1);

    // The change lands while the current hour is already counting down, so
    // it governs from the next arming — not retroactively.
    createSettingsRepo({ db }).setScan({ rescanIntervalMs: 60_000 });
    timers.advance(60_000);
    expect(scans).toHaveLength(1);

    // The hour that was already ticking runs out, and from there the
    // rescan happens every minute, without anything being restarted.
    timers.advance(RESCAN_MS - 60_000);
    await coordinator.idle();
    expect(scans).toHaveLength(2);
    timers.advance(60_000);
    await coordinator.idle();
    expect(scans).toHaveLength(3);
    timers.advance(60_000);
    await coordinator.idle();
    expect(scans).toHaveLength(4);
  });

  it('re-arms even when a whole rescan cycle throws, so the backstop cannot die quietly', async () => {
    const { coordinator, scans, errors, timers, db } = harness();
    coordinator.start();

    // The cycle itself blows up — not one library's scan, the fan-out that
    // decides which libraries to scan. Whatever else happens, the next
    // rescan must still be armed: a timer that stops is a library that
    // stops converging, and it looks exactly like a library with nothing
    // to do.
    db.exec('ALTER TABLE library RENAME TO library_hidden');
    timers.advance(RESCAN_MS);
    expect(scans).toHaveLength(0);
    expect(errors.map((entry) => entry.context)).toEqual([{ libraryId: null, phase: 'rescan' }]);

    db.exec('ALTER TABLE library_hidden RENAME TO library');
    timers.advance(RESCAN_MS);
    await coordinator.idle();
    expect(scans.map((scan) => scan.reason)).toEqual(['interval']);
  });

  it('arms no rescan at all when the interval is set to zero', () => {
    const { coordinator, scans, timers } = harness({ rescanIntervalMs: 0 });
    coordinator.start();
    timers.advance(RESCAN_MS * 24);
    expect(scans).toHaveLength(0);
  });

  it('scans a library created after start-up, since the rescan re-reads the library list', () => {
    const { coordinator, scans, timers, db } = harness();
    coordinator.start();
    const late = createLibraryRepo(db).create({
      name: 'late',
      roots: [mkdtempSync(join(tmpdir(), 'trawlarr-late-'))],
      nowMs: 0,
    });
    timers.advance(RESCAN_MS);
    expect(scans.map((scan) => scan.libraryId)).toContain(late.id);
  });
});

describe('scan coordinator: watchers', () => {
  it('watches every library root, ignoring exactly the reserved directories the walk prunes', () => {
    const { coordinator, watched, libraryIds, db } = harness({ libraries: ['lib-a', 'lib-b'] });
    coordinator.start();
    expect(watched.map((entry) => entry.libraryId).sort()).toEqual([...libraryIds].sort());
    for (const entry of watched) {
      const library = createLibraryRepo(db).getById(entry.libraryId)!;
      expect(entry.ignored).toEqual([join(library.roots[0]!, '.trawlarr')]);
      expect(entry.roots).toEqual(library.roots);
    }
  });

  it('routes a watcher callback into a settled scan of that library only', () => {
    const { coordinator, watched, scans, timers, libraryIds } = harness({
      libraries: ['lib-a', 'lib-b'],
    });
    coordinator.start();
    const forA = watched.find((entry) => entry.libraryId === libraryIds[0]);
    forA?.onChange(join('/anything', 'new.mkv'));
    timers.advance(SETTLE_MS);
    expect(scans).toEqual([{ libraryId: libraryIds[0], reason: 'watch' }]);
  });

  it('starts no watcher at all when watching is disabled', () => {
    const { coordinator, watched } = harness({ watchEnabled: false });
    coordinator.start();
    expect(watched).toHaveLength(0);
  });

  it('closes its watchers and disarms its timers on stop', async () => {
    const { coordinator, timers, scans, closedWatchers, libraryIds } = harness();
    coordinator.start();
    coordinator.request(libraryIds[0]!, 'watch');
    expect(timers.armed()).toBe(2); // the settle timer and the rescan timer
    await coordinator.stop();
    expect(closedWatchers()).toBe(1);
    expect(timers.armed()).toBe(0);
    timers.advance(RESCAN_MS * 3);
    coordinator.request(libraryIds[0]!, 'manual');
    expect(scans).toHaveLength(0);
  });
});

describe('scan coordinator: events', () => {
  it('emits scan.progress and scan.finished, in that order, with the real summary', async () => {
    const { coordinator, events, libraryIds } = harness({
      summary: { seen: 2, added: 1, queued: 1 },
      duringScan: (input) => input.onProgress?.(2),
    });
    coordinator.request(libraryIds[0]!, 'manual');
    await coordinator.idle();
    expect(events.map((event) => event.type)).toEqual(['scan.progress', 'scan.finished']);
    expect(events.at(-1)).toMatchObject({
      libraryId: libraryIds[0],
      summary: { seen: 2, added: 1, queued: 1 },
    });
  });

  it('throttles progress against the injected clock instead of emitting once per file', async () => {
    const { coordinator, events, timers, libraryIds } = harness({
      duringScan: (input) => {
        for (let seen = 1; seen <= 500; seen += 1) input.onProgress?.(seen);
        timers.advance(250);
        input.onProgress?.(501);
        input.onProgress?.(502);
      },
    });
    coordinator.request(libraryIds[0]!, 'manual');
    await coordinator.idle();
    const progress = events.filter((event) => event.type === 'scan.progress');
    expect(progress).toHaveLength(2);
    expect(progress.map((event) => (event as { seen: number }).seen)).toEqual([1, 501]);
  });

  it('emits no scan.finished for a scan that failed: there is no summary to report', async () => {
    const { coordinator, events, libraryIds } = harness({ failFirst: 1 });
    coordinator.request(libraryIds[0]!, 'manual');
    await coordinator.idle();
    expect(events).toHaveLength(0);
  });
});

/**
 * These drive the REAL `scanLibrary` through the coordinator, against a real
 * temp tree and a stub ffprobe, because the two properties they assert —
 * that an unmount is never read as deletion, and that probing is not redone
 * — are properties of the composition, and a fake scanner cannot have them.
 */
describe('scan coordinator: against the real scanner', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  interface RealHarness {
    root: string;
    db: Db;
    coordinator: ScanCoordinator;
    timers: FakeTimers;
    libraryId: string;
    summaries: ScanSummary[];
    probedPaths(): string[];
  }

  const realHarness = (): RealHarness => {
    const base = mkdtempSync(join(tmpdir(), 'trawlarr-realscan-'));
    temps.push(base);
    const root = join(base, 'media');
    mkdirSync(root, { recursive: true });

    // A stub ffprobe that RECORDS which files it was run against: the
    // probe count in the summary and this log are independent evidence of
    // the same thing, and the log says which files, not just how many.
    const probeLog = join(base, 'probed.log');
    const ffprobe = join(base, 'ffprobe.sh');
    writeFileSync(
      ffprobe,
      [
        '#!/bin/sh',
        'for arg in "$@"; do last=$arg; done',
        `printf '%s\\n' "$last" >> ${JSON.stringify(probeLog)}`,
        `printf '%s' '{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080}],"format":{"duration":"60.0","size":"4096","bit_rate":"16384"}}'`,
        '',
      ].join('\n'),
    );
    chmodSync(ffprobe, 0o755);

    const db = openDatabase({ file: ':memory:' });
    migrate(db);
    const libraryId = createLibraryRepo(db).create({ name: 'real', roots: [root], nowMs: 0 }).id;
    const settings = createSettingsRepo({ db });
    settings.setScan({ settleMs: SETTLE_MS, rescanIntervalMs: RESCAN_MS, watchEnabled: false });
    settings.setBinaries({ ffprobe });

    const bus = createEventBus();
    const summaries: ScanSummary[] = [];
    bus.subscribe((event) => {
      if (event.type === 'scan.finished') summaries.push(event.summary);
    });

    const timers = createFakeTimers();
    const coordinator = createScanCoordinator({
      db,
      bus,
      settings,
      nowMs: () => timers.now(),
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (handle) => {
        timers.clearTimer(handle);
      },
    });

    return {
      root,
      db,
      coordinator,
      timers,
      libraryId,
      summaries,
      probedPaths: () => {
        try {
          return readFileSync(probeLog, 'utf8').split('\n').filter(Boolean);
        } catch {
          return [];
        }
      },
    };
  };

  const rowFor = (db: Db, path: string): MediaFileRow =>
    db.prepare(`SELECT * FROM media_file WHERE path = ?`).get(path) as MediaFileRow;

  const stormOfUnlinks = (coordinator: ScanCoordinator, libraryId: string, count: number): void => {
    for (let i = 0; i < count; i += 1) coordinator.request(libraryId, 'watch');
  };

  it('does not read a root that went away as mass deletion, however many unlink events arrive', async () => {
    const real = realHarness();
    writeFileSync(join(real.root, 'a.mkv'), 'a');
    writeFileSync(join(real.root, 'b.mkv'), 'b');
    real.coordinator.request(real.libraryId, 'startup');
    await real.coordinator.idle();
    expect(real.summaries.at(-1)?.added).toBe(2);

    const rowA = rowFor(real.db, join(real.root, 'a.mkv'));
    rmSync(real.root, { recursive: true, force: true });
    stormOfUnlinks(real.coordinator, real.libraryId, 50);
    real.timers.advance(SETTLE_MS);
    await real.coordinator.idle();

    // One scan for the whole storm, and that scan reconciled nothing.
    expect(real.summaries).toHaveLength(2);
    expect(real.summaries.at(-1)).toMatchObject({ missing: 0, rootsUnavailable: 1 });
    expect(rowFor(real.db, rowA.path).missing_since_ms).toBeNull();
    expect(createMediaFileRepo(real.db).getById(rowA.id)).not.toBeNull();
  });

  it('does not read an emptied root as mass deletion either, since that is what an unmount looks like', async () => {
    const real = realHarness();
    writeFileSync(join(real.root, 'a.mkv'), 'a');
    real.coordinator.request(real.libraryId, 'startup');
    await real.coordinator.idle();

    rmSync(join(real.root, 'a.mkv'));
    stormOfUnlinks(real.coordinator, real.libraryId, 5);
    real.timers.advance(SETTLE_MS);
    await real.coordinator.idle();

    expect(real.summaries.at(-1)).toMatchObject({ missing: 0, rootsUnavailable: 1 });
    expect(rowFor(real.db, join(real.root, 'a.mkv')).missing_since_ms).toBeNull();
  });

  it('still marks a genuinely deleted file missing while its root is up', async () => {
    const real = realHarness();
    writeFileSync(join(real.root, 'a.mkv'), 'a');
    writeFileSync(join(real.root, 'b.mkv'), 'b');
    real.coordinator.request(real.libraryId, 'startup');
    await real.coordinator.idle();

    rmSync(join(real.root, 'b.mkv'));
    stormOfUnlinks(real.coordinator, real.libraryId, 5);
    real.timers.advance(SETTLE_MS);
    await real.coordinator.idle();

    expect(real.summaries.at(-1)).toMatchObject({ missing: 1, rootsUnavailable: 0 });
    expect(rowFor(real.db, join(real.root, 'a.mkv')).missing_since_ms).toBeNull();
    expect(rowFor(real.db, join(real.root, 'b.mkv')).missing_since_ms).not.toBeNull();
  });

  it('probes each file once and resumes rather than restarting: a later scan re-probes nothing already recorded', async () => {
    const real = realHarness();
    writeFileSync(join(real.root, 'a.mkv'), 'a');
    writeFileSync(join(real.root, 'b.mkv'), 'b');

    real.coordinator.request(real.libraryId, 'startup');
    await real.coordinator.idle();
    expect(real.summaries.at(-1)).toMatchObject({ seen: 2, probed: 2 });
    expect(real.probedPaths()).toHaveLength(2);

    real.coordinator.request(real.libraryId, 'interval');
    await real.coordinator.idle();
    expect(real.summaries.at(-1)).toMatchObject({ seen: 2, probed: 0 });
    expect(real.probedPaths()).toHaveLength(2);

    // The part that makes an interrupted scan cheap: work already recorded
    // is never redone, so only the files a previous scan never got to cost
    // anything.
    writeFileSync(join(real.root, 'c.mkv'), 'c');
    real.coordinator.request(real.libraryId, 'interval');
    await real.coordinator.idle();
    expect(real.summaries.at(-1)).toMatchObject({ seen: 3, probed: 1 });
    expect([...real.probedPaths()].sort()).toEqual([
      join(real.root, 'a.mkv'),
      join(real.root, 'b.mkv'),
      join(real.root, 'c.mkv'),
    ]);
  });

  it('re-probes a file whose size changed, so a probe taken mid-write is never final', async () => {
    const real = realHarness();
    const path = join(real.root, 'growing.mkv');
    writeFileSync(path, 'partial');
    real.coordinator.request(real.libraryId, 'startup');
    await real.coordinator.idle();

    writeFileSync(path, 'partial plus the rest of the download');
    real.coordinator.request(real.libraryId, 'interval');
    await real.coordinator.idle();
    expect(real.summaries.at(-1)).toMatchObject({ probed: 1 });
    expect(real.probedPaths()).toEqual([path, path]);
  });
});
