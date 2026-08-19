import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { reservedDirsForLibrary } from '../library/paths.js';
import { createChokidarWatchPort, type WatchHandle } from './watcher.js';

/**
 * Poll a CONDITION, never a fixed sleep for "long enough".
 *
 * inotify delivery is asynchronous and the OS decides when; a test that
 * slept a chosen number of milliseconds would be asserting about that
 * choice. `poke` runs on every pass so the watcher gets repeated chances
 * to observe the same change — a watcher still finishing its initial scan
 * simply sees a later write instead of the first one, which is why this
 * does not depend on chokidar's `ready` timing.
 */
const waitUntil = async (
  condition: () => boolean,
  options: { poke?: () => void; timeoutMs?: number } = {},
): Promise<void> => {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    options.poke?.();
    if (condition()) return;
    if (Date.now() > deadline) throw new Error('condition was never met before the deadline');
    await delay(25);
  }
};

let base: string;
let root: string;
let db: Db;
let library: LibraryRecord;
const handles: WatchHandle[] = [];

const watchLibrary = (onChange: (path: string) => void): WatchHandle => {
  const handle = createChokidarWatchPort().watch({
    libraryId: library.id,
    roots: library.roots,
    ignored: reservedDirsForLibrary(library),
    onChange,
  });
  handles.push(handle);
  return handle;
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-watch-'));
  root = join(base, 'media');
  mkdirSync(join(root, '.trawlarr', 'staging'), { recursive: true });
  mkdirSync(join(root, '.trawlarr', 'trash'), { recursive: true });
  mkdirSync(join(root, 'shows'), { recursive: true });
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  library = createLibraryRepo(db).create({ name: 'watched', roots: [root], nowMs: 0 });
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('chokidar watch port', () => {
  it('reports a new file under a root, by path', async () => {
    const seen: string[] = [];
    watchLibrary((path) => seen.push(path));

    const added = join(root, 'shows', 'real.mkv');
    let generation = 0;
    await waitUntil(() => seen.includes(added), {
      poke: () => {
        generation += 1;
        writeFileSync(added, `content ${String(generation)}`);
      },
    });
  });

  it('reports a deletion too, since a removed file is something only a scan can interpret', async () => {
    const removed = join(root, 'gone.mkv');
    writeFileSync(removed, 'x');
    const seen: string[] = [];
    watchLibrary((path) => seen.push(path));

    // Establish that this watcher is live before removing anything, so the
    // assertion below is about the unlink and not about start-up timing.
    const canary = join(root, 'canary.mkv');
    await waitUntil(() => seen.includes(canary), {
      poke: () => writeFileSync(canary, String(Date.now())),
    });

    seen.length = 0;
    rmSync(removed);
    await waitUntil(() => seen.includes(removed));
  });

  it('ignores everything trawlarr writes inside the library root', async () => {
    const seen: string[] = [];
    watchLibrary((path) => seen.push(path));

    const staged = join(root, '.trawlarr', 'staging', 'part.mkv');
    const trashed = join(root, '.trawlarr', 'trash', 'deleted.mkv');
    const real = join(root, 'real.mkv');

    let generation = 0;
    await waitUntil(
      // Three separate observations of the real file: by the time the
      // watcher has reported the third write, it has had every chance to
      // report the staging and trash writes made in the same passes.
      () => seen.filter((path) => path === real).length >= 3,
      {
        poke: () => {
          generation += 1;
          const content = `content ${String(generation)}`;
          writeFileSync(staged, content);
          writeFileSync(trashed, content);
          writeFileSync(real, content);
        },
      },
    );

    expect(seen.some((path) => path.includes('.trawlarr'))).toBe(false);
  });

  it('stops reporting once closed', async () => {
    const closedSeen: string[] = [];
    const stillOpen: string[] = [];
    const closing = watchLibrary((path) => closedSeen.push(path));
    watchLibrary((path) => stillOpen.push(path));

    const first = join(root, 'before.mkv');
    await waitUntil(() => closedSeen.includes(first) && stillOpen.includes(first), {
      poke: () => writeFileSync(first, String(Date.now())),
    });

    await closing.close();
    closedSeen.length = 0;
    stillOpen.length = 0;

    // The second, still-open watcher is the barrier: once IT has seen the
    // write, the closed one has had exactly the same opportunity.
    const after = join(root, 'after.mkv');
    await waitUntil(() => stillOpen.filter((path) => path === after).length >= 3, {
      poke: () => writeFileSync(after, String(Date.now())),
    });
    expect(closedSeen).toEqual([]);
  });
});
