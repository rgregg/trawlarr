import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { createSettingsRepo } from '../db/settings-repo.js';
import { scanLibrary } from '../scanner/scan-library.js';
import { FAKE_PROBE_DOCUMENT } from '../../test/helpers/fake-ffprobe.js';
import { createEventBus } from './events.js';
import { createScanCoordinator, type ScanCoordinator } from './scan-coordinator.js';

/** Counts the synchronous canonicalisations made by trawlarr's own modules. */
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

const fixedProbe = (path: string): ProbeData =>
  ({
    ...FAKE_PROBE_DOCUMENT,
    format: { ...FAKE_PROBE_DOCUMENT.format, filename: path },
  }) as ProbeData;

const FOLDERS = 8;

let base: string;
let root: string;
let db: Db;
let libraryId: string;
let coordinator: ScanCoordinator;
let scopes: (readonly string[] | undefined)[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-coord-blocking-'));
  root = join(base, 'library');
  mkdirSync(join(root, '.trawlarr', 'trash'), { recursive: true });
  for (let index = 0; index < FOLDERS; index += 1) {
    mkdirSync(join(root, `Film ${String(index)}`, 'extras'), { recursive: true });
    writeFileSync(join(root, `Film ${String(index)}`, 'film.mkv'), `film ${String(index)}`);
    writeFileSync(join(root, `Film ${String(index)}`, 'extras', 'x.mkv'), `extra ${String(index)}`);
  }
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  libraryId = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv'],
    nowMs: 0,
  }).id;
  scopes = [];
  coordinator = createScanCoordinator({
    db,
    bus: createEventBus(),
    settings: createSettingsRepo({ db }),
    nowMs: () => 1_000,
    watchPort: { watch: () => ({ close: async () => {} }) },
    scanFn: (input) => {
      scopes.push(input.scope);
      return scanLibrary({
        ...input,
        probeFileImpl: async (probe) => fixedProbe(probe.path),
      });
    },
    onError: (error) => {
      throw error;
    },
  });
});

afterEach(async () => {
  await coordinator.stop();
  db.close();
  rmSync(base, { recursive: true, force: true });
});

// `request()` runs the scan's synchronous prefix on its caller's stack, and
// its caller is a webhook handler on the daemon's only thread. A scoped scan
// used to canonicalise the library's roots and reserved directories there with
// `realpathSync` — six times for one notified folder, sixteen for five — and on
// an NFS library each of those can wait seconds behind a copy, with the API and
// the event socket frozen meanwhile. Nothing a scan does, at its start or
// later, may read the filesystem synchronously.
it('reads nothing synchronously to request and run a scoped scan of several folders', async () => {
  const folders = [0, 1, 2, 3, 4].map((index) => join(root, `Film ${String(index)}`));
  const before = realpathCalls.count;

  coordinator.request(libraryId, 'notify', folders);
  expect(realpathCalls.count - before).toBe(0);
  await coordinator.idle();

  expect(scopes).toEqual([folders]);
  expect(realpathCalls.count - before).toBe(0);
});

it('reads nothing synchronously to request and run a full scan', async () => {
  const before = realpathCalls.count;

  coordinator.request(libraryId, 'manual');
  expect(realpathCalls.count - before).toBe(0);
  await coordinator.idle();

  expect(scopes).toEqual([undefined]);
  expect(realpathCalls.count - before).toBe(0);
});

// The end of a scan as well as its start: deciding which unseen rows the
// missing pass may consider used to cost two `realpathSync` per row.
it('reads nothing synchronously to run a scoped scan that marks rows missing', async () => {
  coordinator.request(libraryId, 'startup');
  await coordinator.idle();
  const deleted = [0, 1, 2].map((index) => join(root, `Film ${String(index)}`));
  for (const folder of deleted) rmSync(folder, { recursive: true });
  const before = realpathCalls.count;

  coordinator.request(libraryId, 'notify', deleted);
  await coordinator.idle();

  const missing = createMediaFileRepo(db)
    .listByLibrary({ libraryId })
    .filter((row) => row.missing_since_ms !== null);
  expect(missing).toHaveLength(6);
  expect(realpathCalls.count - before).toBe(0);
});

it('reads nothing synchronously to run a full scan that marks rows missing', async () => {
  coordinator.request(libraryId, 'startup');
  await coordinator.idle();
  rmSync(join(root, 'Film 0'), { recursive: true });
  const before = realpathCalls.count;

  coordinator.request(libraryId, 'manual');
  await coordinator.idle();

  const missing = createMediaFileRepo(db)
    .listByLibrary({ libraryId })
    .filter((row) => row.missing_since_ms !== null);
  expect(missing).toHaveLength(2);
  expect(realpathCalls.count - before).toBe(0);
});
