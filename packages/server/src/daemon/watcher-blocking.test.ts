import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createChokidarWatchPort, type WatchHandle } from './watcher.js';

/**
 * Counts the synchronous canonicalisations trawlarr's own modules make.
 * chokidar is an external dependency and is not routed through this mock, so
 * the count is exactly the watcher's own blocking filesystem reads.
 */
const realpathCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: ((...args: Parameters<typeof actual.realpathSync>) => {
      realpathCalls.count += 1;
      return actual.realpathSync(...args);
    }) as typeof actual.realpathSync,
  };
});

let base: string;
let root: string;
let handle: WatchHandle | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-watch-blocking-'));
  root = join(base, 'media');
  mkdirSync(join(root, '.trawlarr', 'staging'), { recursive: true });
  mkdirSync(join(root, 'movies'), { recursive: true });
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  rmSync(base, { recursive: true, force: true });
});

// A replacement copying onto an NFS library is a stream of events for one
// growing file, and a stat of that file waits behind the write. When the
// ignore check canonicalised every event's path, that wait happened on the
// daemon's only thread and froze the API for up to 29 seconds at a time. The
// cost of an event must not include a synchronous read of the path it names.
it('makes no synchronous filesystem read per event', async () => {
  const seen: string[] = [];
  handle = createChokidarWatchPort().watch({
    libraryId: 'library',
    roots: [root],
    ignored: [join(root, '.trawlarr')],
    onChange: (path) => seen.push(path),
  });

  const growing = join(root, 'movies', 'growing.mkv');
  const write = (generation: number): void => {
    writeFileSync(growing, `content ${String(generation)}`);
    writeFileSync(join(root, '.trawlarr', 'staging', 'part.mkv'), `content ${String(generation)}`);
  };

  // Until the first event arrives the watcher may still be reading the tree.
  let generation = 0;
  const deadline = Date.now() + 10_000;
  while (seen.length === 0) {
    if (Date.now() > deadline) throw new Error('the watcher never reported the first write');
    write((generation += 1));
    await delay(25);
  }
  const afterFirstEvent = realpathCalls.count;
  const eventsSoFar = seen.length;

  while (seen.length < eventsSoFar + 3) {
    if (Date.now() > deadline) throw new Error('the watcher stopped reporting writes');
    write((generation += 1));
    await delay(25);
  }

  expect(realpathCalls.count).toBe(afterFirstEvent);
});
