import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
import type { WatchInput } from './watcher.js';

const fixedProbe = (path: string): ProbeData =>
  ({
    ...FAKE_PROBE_DOCUMENT,
    format: { ...FAKE_PROBE_DOCUMENT.format, filename: path },
  }) as ProbeData;

let base: string;
let root: string;
let db: Db;
let libraryId: string;
let coordinator: ScanCoordinator;
let watched: WatchInput[];
let probed: string[];
let scopes: (readonly string[] | undefined)[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-coord-scoped-'));
  root = join(base, 'library');
  for (let index = 0; index < 20; index += 1) {
    mkdirSync(join(root, `Film ${String(index)}`), { recursive: true });
    writeFileSync(join(root, `Film ${String(index)}`, 'film.mkv'), `film ${String(index)}`);
  }
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  libraryId = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv'],
    nowMs: 0,
  }).id;
  const settings = createSettingsRepo({ db });
  settings.setScan({ settleMs: 0 });
  watched = [];
  probed = [];
  scopes = [];
  coordinator = createScanCoordinator({
    db,
    bus: createEventBus(),
    settings,
    nowMs: () => 1_000,
    watchPort: {
      watch: (input) => {
        watched.push(input);
        return { close: async () => {} };
      },
    },
    scanFn: (input) => {
      scopes.push(input.scope);
      return scanLibrary({
        ...input,
        probeFileImpl: async (probe) => {
          probed.push(probe.path);
          return fixedProbe(probe.path);
        },
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

it('adds a file the watcher reported without walking the rest of the library', async () => {
  coordinator.start();
  coordinator.request(libraryId, 'startup');
  await coordinator.idle();
  expect(probed).toHaveLength(20);
  probed = [];
  scopes = [];

  const added = join(root, 'Film 3', 'film (extended).mkv');
  writeFileSync(added, 'the extended cut');
  watched[0]!.onChange(added);
  // idle() does not see a burst that is still settling (an armed settle timer is
  // neither running nor pending), so wait for the scan this test expects rather
  // than for a duration. The deadline is inside vitest's 5 s test timeout, so
  // a scan that never comes fails with this message and not with a bare
  // "test timed out".
  const deadline = Date.now() + 3_000;
  while (scopes.length === 0) {
    if (Date.now() > deadline) throw new Error('the watcher-reported file was never scanned');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await coordinator.idle();

  expect(scopes).toEqual([[added]]);
  expect(probed).toEqual([added]);
  expect(
    createMediaFileRepo(db)
      .listByLibrary({ libraryId })
      .some((row) => row.path === added),
  ).toBe(true);
});
