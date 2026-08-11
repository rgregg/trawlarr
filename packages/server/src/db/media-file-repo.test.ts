import { beforeEach, describe, expect, it } from 'vitest';
import { buildIdentityCandidate, matchIdentity } from '@trawlarr/core';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createMediaFileRepo, type MediaFileRepo } from './media-file-repo.js';

const NOW = 1_700_000_000_000;
const LIB = 'lib-movies';
const hash = { sizeBytes: 4096, headHex: 'aa', tailHex: 'bb' };

let db: Db;
let repo: MediaFileRepo;

const seedLibrary = () => {
  db.prepare(`INSERT INTO library (id, name, created_at) VALUES (?, ?, ?)`).run(LIB, 'Movies', NOW);
};

const scan = (over: Partial<Parameters<MediaFileRepo['upsertScanned']>[0]> = {}) => {
  const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
  return repo.upsertScanned({
    libraryId: LIB,
    identity: candidate,
    path: '/media/movies/Arrival.mkv',
    nlink: 1,
    sizeBytes: hash.sizeBytes,
    mtimeMs: NOW,
    ctimeMs: NOW,
    container: 'mkv',
    nowMs: NOW,
    ...over,
  });
};

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  seedLibrary();
  repo = createMediaFileRepo(db);
});

describe('upsertScanned and identity', () => {
  it('inserts a new file', () => {
    const id = scan();
    expect(repo.getById(id)?.path).toBe('/media/movies/Arrival.mkv');
  });

  it('keeps the same record when a file is renamed — the whole point of identity', () => {
    const first = scan();
    const second = scan({ path: '/media/movies/Arrival (2016) [Bluray-1080p].mkv' });
    expect(second).toBe(first);
    expect(repo.getById(first)?.path).toBe('/media/movies/Arrival (2016) [Bluray-1080p].mkv');
    const count = db.prepare(`SELECT COUNT(*) AS c FROM media_file`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('preserves ledger state across a rename', () => {
    const id = scan();
    repo.setState({ fileId: id, state: 'good', signature: 'sig-1' });
    scan({ path: '/media/movies/renamed.mkv' });
    expect(repo.getById(id)).toMatchObject({ state: 'good', signature: 'sig-1' });
  });

  it('matches by content when the inode changed', () => {
    const id = scan();
    const moved = buildIdentityCandidate({ deviceId: 3000, inode: 999, hash });
    expect(scan({ identity: moved })).toBe(id);
  });

  it('resolves identity through the shared core matcher', () => {
    scan();
    const lookup = repo.identityLookup(LIB);
    const same = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
    expect(matchIdentity(same, lookup).matchedBy).toBe('inode');

    const different = buildIdentityCandidate({
      deviceId: 2049,
      inode: 43,
      hash: { ...hash, headHex: 'ff' },
    });
    expect(matchIdentity(different, lookup).fileId).toBeNull();
  });

  it('records hardlink count so seeding files can be skipped', () => {
    const id = scan({ nlink: 2 });
    expect(repo.getById(id)?.nlink).toBe(2);
  });
});

describe('claimNext', () => {
  const queueOne = () => {
    const id = scan();
    repo.setState({ fileId: id, state: 'queued' });
    return id;
  };

  it('returns null when nothing is queued', () => {
    scan();
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();
  });

  it('claims a queued file and marks it running', () => {
    const id = queueOne();
    const claim = repo.claimNext({ workerClass: 'transcode', nowMs: NOW });
    expect(claim?.fileId).toBe(id);
    expect(repo.getById(id)?.state).toBe('running');
  });

  it('never hands the same file to two workers', () => {
    queueOne();
    const first = repo.claimNext({ workerClass: 'transcode', nowMs: NOW });
    const second = repo.claimNext({ workerClass: 'transcode', nowMs: NOW });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('hands out each file exactly once under repeated contention', () => {
    for (let i = 0; i < 25; i += 1) {
      const id = scan({
        identity: buildIdentityCandidate({
          deviceId: 2049,
          inode: 100 + i,
          hash: { ...hash, headHex: `h${i}` },
        }),
        path: `/media/movies/film-${i}.mkv`,
      });
      repo.setState({ fileId: id, state: 'queued' });
    }
    const claimed = new Set<string>();
    for (;;) {
      const claim = repo.claimNext({ workerClass: 'transcode', nowMs: NOW });
      if (claim === null) break;
      expect(claimed.has(claim.fileId)).toBe(false);
      claimed.add(claim.fileId);
    }
    expect(claimed.size).toBe(25);
  });

  it('skips a held file until its hold expires', () => {
    const id = scan();
    repo.setState({ fileId: id, state: 'held', holdUntilMs: NOW + 1000 });
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW + 2000 })?.fileId).toBe(id);
  });

  it('never claims terminal files', () => {
    for (const state of ['good', 'failed', 'not_converging'] as const) {
      const id = scan({
        identity: buildIdentityCandidate({
          deviceId: 2049,
          inode: 500,
          hash: { ...hash, headHex: state },
        }),
        path: `/media/movies/${state}.mkv`,
      });
      repo.setState({ fileId: id, state });
    }
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();
  });

  it('orders by priority then discovery time', () => {
    const older = scan({
      identity: buildIdentityCandidate({
        deviceId: 2049,
        inode: 1,
        hash: { ...hash, headHex: '01' },
      }),
      path: '/a.mkv',
      nowMs: NOW,
    });
    const urgent = scan({
      identity: buildIdentityCandidate({
        deviceId: 2049,
        inode: 2,
        hash: { ...hash, headHex: '02' },
      }),
      path: '/b.mkv',
      nowMs: NOW + 5000,
    });
    repo.setState({ fileId: older, state: 'queued' });
    repo.setState({ fileId: urgent, state: 'queued' });
    db.prepare(`UPDATE media_file SET priority = 10 WHERE id = ?`).run(urgent);

    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW + 9000 })?.fileId).toBe(urgent);
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW + 9000 })?.fileId).toBe(older);
  });

  it('honours a library filter', () => {
    db.prepare(`INSERT INTO library (id, name, created_at) VALUES (?, ?, ?)`).run(
      'lib-tv',
      'TV',
      NOW,
    );
    queueOne();
    expect(
      repo.claimNext({ workerClass: 'transcode', nowMs: NOW, libraryIds: ['lib-tv'] }),
    ).toBeNull();
    expect(
      repo.claimNext({ workerClass: 'transcode', nowMs: NOW, libraryIds: [LIB] }),
    ).not.toBeNull();
  });
});
