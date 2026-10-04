import { beforeEach, describe, expect, it } from 'vitest';
import { RUNTIME_RETRY_MS } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { migrate } from '../db/migrate.js';
import { createSettingsRepo, type SettingsRepo } from '../db/settings-repo.js';
import type { RuntimeFetch } from '../library/runtime-sources.js';
import { createRuntimeChecker } from './runtime-checker.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
let db: Db;
let settings: SettingsRepo;
let libraryId: string;
let now = NOW;

const seedFile = (id: string, durationMs: number | null, extra = ''): void => {
  db.prepare(
    `INSERT INTO media_file (id, library_id, inode_key, content_key, path, nlink, size_bytes,
       mtime_ms, ctime_ms, container, state, duration_ms, discovered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, 0, 0, 'mkv', 'good', ?, 0, 0)`,
  ).run(id, libraryId, `i-${id}`, `c-${id}`, `/m/${id}.2000.mkv`, durationMs);
  if (extra !== '') db.exec(extra);
};

const row = (id: string) =>
  db
    .prepare(
      `SELECT expected_runtime_ms AS e, expected_runtime_source AS s, runtime_checked_at AS c
         FROM media_file WHERE id = ?`,
    )
    .get(id) as { e: number | null; s: string | null; c: number | null };

const arrAnswering = (runtime: number): RuntimeFetch & { calls: string[] } => {
  const calls: string[] = [];
  return Object.assign(
    ((url: string) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ movie: { runtime } }),
      });
    }) as RuntimeFetch,
    { calls },
  );
};

const checker = (fetchImpl: RuntimeFetch, over: { batch?: number } = {}) =>
  createRuntimeChecker({
    db,
    settings,
    nowMs: () => now,
    fetchImpl,
    pause: () => Promise.resolve(),
    ...over,
  });

beforeEach(() => {
  now = NOW;
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  settings = createSettingsRepo({ db });
  const repo = createLibraryRepo(db);
  const library = repo.create({ name: 'Movies', roots: ['/m'], nowMs: NOW });
  libraryId = library.id;
  repo.update({
    id: libraryId,
    runtime: { kind: 'radarr', url: 'http://r', apiKey: 'k', percent: 5, minutes: 3 },
  });
});

describe('runtime checker', () => {
  it('records the expected runtime and source, and does not ask again until stale', async () => {
    seedFile('a', 100 * MIN);
    const f = arrAnswering(120);

    expect(await checker(f).runOnce()).toBe(1);
    expect(row('a')).toEqual({ e: 120 * MIN, s: 'radarr', c: NOW });

    expect(await checker(f).runOnce()).toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it('skips files with no measured duration, and does nothing for a library with no source', async () => {
    seedFile('a', null);
    const f = arrAnswering(120);
    expect(await checker(f).runOnce()).toBe(0);

    createLibraryRepo(db).update({
      id: libraryId,
      runtime: { kind: null, url: '', apiKey: '', percent: 5, minutes: 3 },
    });
    seedFile('b', 100 * MIN);
    expect(await checker(f).runOnce()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it('respects the batch size, which is the rate limit', async () => {
    for (const id of ['a', 'b', 'c']) seedFile(id, 100 * MIN);
    expect(await checker(arrAnswering(120), { batch: 2 }).runOnce()).toBe(2);
  });

  it('records a miss as checked-with-no-runtime, and retries it later', async () => {
    seedFile('a', 100 * MIN);
    const miss: RuntimeFetch = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ movie: null }) });
    await checker(miss).runOnce();
    expect(row('a')).toEqual({ e: null, s: null, c: NOW });

    now += RUNTIME_RETRY_MS;
    expect(await checker(arrAnswering(120)).runOnce()).toBe(1);
    expect(row('a').e).toBe(120 * MIN);
  });

  it('survives a source that is down: no runtime is stored, and the pass stops early', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) seedFile(id, 100 * MIN);
    const messages: string[] = [];
    const down: RuntimeFetch = () => Promise.reject(new Error('ECONNREFUSED'));

    const done = await createRuntimeChecker({
      db,
      settings,
      nowMs: () => now,
      fetchImpl: down,
      pause: () => Promise.resolve(),
      onError: (m) => messages.push(m),
    }).runOnce();

    expect(done).toBe(3);
    expect(messages).toHaveLength(1);
    expect(row('a').e).toBeNull();
    expect(row('d').c).toBeNull();
  });

  it('uses the global TMDB key for a library with no arr instance', async () => {
    createLibraryRepo(db).update({
      id: libraryId,
      runtime: { kind: null, url: '', apiKey: '', percent: 5, minutes: 3 },
    });
    settings.setMetadata({ tmdbApiKey: 'abc' });
    seedFile('a', 100 * MIN);
    const f: RuntimeFetch = (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(url.includes('/search/') ? { results: [{ id: 1 }] } : { runtime: 95 }),
      });

    await checker(f).runOnce();
    expect(row('a')).toEqual({ e: 95 * MIN, s: 'tmdb', c: NOW });
  });
});
