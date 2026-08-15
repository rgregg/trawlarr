import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildIdentityCandidate,
  extractFacts,
  matchIdentity,
  newLedgerRecord,
} from '@trawlarr/core';
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

  describe('conflicting inode and content matches', () => {
    // Row A: inode 42, content Ka. Row B: some other inode, content Kb.
    // Then A's path is rescanned but its bytes now match B's content key
    // (e.g. the file was replaced in place by a copy of B, or a dedup tool
    // rewrote its content) while its inode is still 42. The inode lookup
    // would match row A, but writing Kb onto row A collides with row B's
    // UNIQUE (library_id, content_key). Content identity must win: the
    // bytes now belong to B's record, so B should absorb the rescan.
    const hashB = { sizeBytes: 8192, headHex: 'cc', tailHex: 'dd' };

    const seedTwoRows = () => {
      const a = scan({
        identity: buildIdentityCandidate({ deviceId: 2049, inode: 42, hash }),
        path: '/media/movies/A.mkv',
      });
      const b = scan({
        identity: buildIdentityCandidate({ deviceId: 2049, inode: 77, hash: hashB }),
        path: '/media/movies/B.mkv',
      });
      return { a, b };
    };

    it('resolves an inode/content match split across two rows by favouring content, without throwing', () => {
      const { a, b } = seedTwoRows();

      // A's path, rescanned with A's inode but B's content key.
      const conflicting = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash: hashB });

      let resolvedId!: string;
      expect(() => {
        resolvedId = scan({ identity: conflicting, path: '/media/movies/A.mkv' });
      }).not.toThrow();

      expect(resolvedId).toBe(b);

      const count = db.prepare(`SELECT COUNT(*) AS c FROM media_file`).get() as { c: number };
      expect(count.c).toBe(2);

      expect(repo.getById(b)).toMatchObject({
        path: '/media/movies/A.mkv',
        content_key: expect.any(String),
      });
      void a;
    });

    it('clears the losing row inode_key and stays stable on a repeat scan', () => {
      const { a, b } = seedTwoRows();
      const conflicting = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash: hashB });

      scan({ identity: conflicting, path: '/media/movies/A.mkv' });

      // Row A no longer owns inode 42.
      expect(repo.getById(a)?.inode_key).toBeNull();

      // Rescanning again with the same inputs must be stable: no throw,
      // same resolved row, no flip-flopping between A and B.
      let resolvedAgain!: string;
      expect(() => {
        resolvedAgain = scan({ identity: conflicting, path: '/media/movies/A.mkv' });
      }).not.toThrow();
      expect(resolvedAgain).toBe(b);

      const count = db.prepare(`SELECT COUNT(*) AS c FROM media_file`).get() as { c: number };
      expect(count.c).toBe(2);
    });

    it('still matches by inode alone when only the inode-matched row exists', () => {
      const id = scan({
        identity: buildIdentityCandidate({ deviceId: 2049, inode: 42, hash }),
        path: '/media/movies/A.mkv',
      });
      const again = scan({
        identity: buildIdentityCandidate({
          deviceId: 2049,
          inode: 42,
          hash: { ...hash, headHex: 'zz' },
        }),
        path: '/media/movies/A.mkv',
      });
      expect(again).toBe(id);
      const count = db.prepare(`SELECT COUNT(*) AS c FROM media_file`).get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('still matches by content alone when only the content-matched row exists', () => {
      const id = scan({
        identity: buildIdentityCandidate({ deviceId: 2049, inode: 42, hash }),
        path: '/media/movies/A.mkv',
      });
      const again = scan({
        identity: buildIdentityCandidate({ deviceId: 3000, inode: 999, hash }),
        path: '/media/movies/A.mkv',
      });
      expect(again).toBe(id);
      const count = db.prepare(`SELECT COUNT(*) AS c FROM media_file`).get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('inserts a new row when neither inode nor content matches', () => {
      seedTwoRows();
      const fresh = scan({
        identity: buildIdentityCandidate({
          deviceId: 2049,
          inode: 555,
          hash: { ...hash, headHex: 'ee' },
        }),
        path: '/media/movies/C.mkv',
      });
      const count = db.prepare(`SELECT COUNT(*) AS c FROM media_file`).get() as { c: number };
      expect(count.c).toBe(3);
      expect(repo.getById(fresh)?.path).toBe('/media/movies/C.mkv');
    });
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
    // Each state needs its OWN inode AND its own content hash: upsertScanned
    // resolves identity by inode first and by content second, so three files
    // sharing either one collapse into a single row and the loop below just
    // overwrites one file's state three times. That degenerate version of this
    // test passed even when claimNext handed out 'good' and 'failed' files,
    // because there was only ever one row and it was 'not_converging'.
    const ids = ['good', 'failed', 'not_converging'].map((state, index) =>
      scan({
        identity: buildIdentityCandidate({
          deviceId: 2049,
          inode: 500 + index,
          hash: { ...hash, headHex: `terminal-${state}` },
        }),
        path: `/media/movies/${state}.mkv`,
      }),
    );
    expect(new Set(ids).size).toBe(3);

    const states = ['good', 'failed', 'not_converging'] as const;
    ids.forEach((id, index) => repo.setState({ fileId: id, state: states[index]! }));
    for (const [index, state] of states.entries()) {
      expect(repo.getById(ids[index]!)?.state).toBe(state);
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

describe('probe, facts and ledger persistence', () => {
  const probe = {
    format: { duration: '1440.5', bit_rate: '8000000' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
      { index: 1, codec_type: 'audio', codec_name: 'eac3' },
    ],
  };

  it('stores the probe and the denormalised columns used for filtering', () => {
    const id = scan();
    const facts = extractFacts({ probe: probe as never, container: 'mkv', sizeBytes: 4096 });
    repo.setProbe({ fileId: id, probe: probe as never, facts });

    const stored = repo.getProbe(id);
    expect(stored?.probe).toEqual(probe);
    expect(stored?.facts).toEqual(facts);

    const row = db.prepare(`SELECT * FROM media_file WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >;
    expect(row.video_codec).toBe('h264');
    expect(row.audio_codec).toBe('eac3');
    expect(row.resolution).toBe('1080p');
    expect(row.duration_ms).toBe(1_440_500);
    expect(row.bitrate).toBe(8_000_000);
  });

  it('returns null for a file that has never been probed', () => {
    expect(repo.getProbe(scan())).toBeNull();
  });

  it('reflects the row current container, not the container at probe time, when the row changes without a re-probe', () => {
    const id = scan();
    const facts = extractFacts({ probe: probe as never, container: 'mkv', sizeBytes: 4096 });
    repo.setProbe({ fileId: id, probe: probe as never, facts });
    expect(repo.getProbe(id)?.facts.container).toBe('mkv');

    // Rescan the same identity but report a different container, without a
    // re-probe. upsertScanned updates container/size_bytes independently of
    // probe_json, so getProbe's recomputed facts pick up the new container —
    // this is "facts as of now, read through the stored probe", not "facts
    // as of probe time". A caller needing the latter must extract facts
    // itself from the probe it has in hand.
    scan({ container: 'avi' });

    expect(repo.getProbe(id)?.facts.container).toBe('avi');
    expect(repo.getProbe(id)?.probe).toEqual(probe);
  });

  it('round-trips a ledger record', () => {
    const id = scan();
    const record = {
      state: 'held' as const,
      signature: 'sig-1',
      attemptCount: 2,
      consecutiveNoopCount: 1,
      holdUntilMs: NOW + 5000,
    };
    repo.setLedger({ fileId: id, record });
    expect(repo.getLedger(id)).toEqual(record);
  });

  it('stores the pre and post fact sets a run recorded', () => {
    const id = scan();
    const pre = extractFacts({ probe: probe as never, container: 'mkv', sizeBytes: 4096 });
    const post = extractFacts({ probe: probe as never, container: 'mkv', sizeBytes: 2048 });
    repo.setLedger({
      fileId: id,
      record: newLedgerRecord(),
      preFacts: pre,
      postFacts: post,
      lastRunId: 'job-1',
    });
    const row = db.prepare(`SELECT * FROM media_file WHERE id = ?`).get(id) as Record<
      string,
      string
    >;
    expect(JSON.parse(row.pre_facts_json!)).toEqual(pre);
    expect(JSON.parse(row.post_facts_json!)).toEqual(post);
    expect(row.last_run_id).toBe('job-1');
  });

  it(
    'updateAfterRun overwrites identity/path/stat on the SAME row, so the next scan matches ' +
      'it again instead of opening a second row for what looks like a new file',
    () => {
      const id = scan();
      const replaced = buildIdentityCandidate({ deviceId: 2049, inode: 999, hash });

      repo.updateAfterRun({
        fileId: id,
        identity: replaced,
        path: '/media/movies/Arrival.mkv',
        nlink: 1,
        sizeBytes: 12_345,
        mtimeMs: NOW + 10,
        ctimeMs: NOW + 10,
        container: 'mp4',
        nowMs: NOW + 10,
      });

      // Same row, id unchanged — this is an update in place, not an insert.
      expect(db.prepare(`SELECT COUNT(*) AS c FROM media_file`).get()).toEqual({ c: 1 });
      const row = repo.getById(id);
      expect(row).toMatchObject({
        inode_key: replaced.inodeKey,
        content_key: replaced.contentKey,
        size_bytes: 12_345,
        container: 'mp4',
      });

      // The whole point: a lookup keyed on the NEW identity — the shape a
      // subsequent scan of the replaced file would perform — now finds this
      // row, not nothing (which is what forced the scanner to insert a
      // second, orphaned row before this method existed).
      const lookup = repo.identityLookup(LIB);
      expect(lookup.byInodeKey(replaced.inodeKey!)).toBe(id);
      expect(lookup.byContentKey(replaced.contentKey)).toBe(id);
      // And the OLD identity no longer resolves to anything.
      expect(lookup.byInodeKey('2049:42')).toBeNull();
    },
  );

  it('updateAfterRun clears a colliding inode_key from EVERY row that holds it, not just one', () => {
    // `inode_key` carries only an index, not a UNIQUE constraint (unlike
    // `content_key`), so two rows sharing one is possible historically —
    // simulated here with a direct insert bypassing `upsertScanned`'s own
    // (newer) defensive clearing.
    const sharedInodeKey = '2049:555';
    const rowA = scan({
      identity: buildIdentityCandidate({
        deviceId: 2049,
        inode: 555,
        hash: { sizeBytes: 1, headHex: 'row-a-head', tailHex: 'row-a-tail' },
      }),
    });
    db.prepare(
      `INSERT INTO media_file (
           id, library_id, inode_key, content_key, path, nlink,
           size_bytes, mtime_ms, ctime_ms, container, state, discovered_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'mkv', 'unknown', ?, ?)`,
    ).run(
      'row-b',
      LIB,
      sharedInodeKey,
      'content-key-b-distinct',
      '/media/movies/Other.mkv',
      hash.sizeBytes,
      NOW,
      NOW,
      NOW,
      NOW,
    );
    expect(repo.getById('row-b')?.inode_key).toBe(sharedInodeKey);

    // A third, unrelated row is the one a run now claims the SAME inode
    // for (a fresh replacement whose new inode happens to be a reused
    // number).
    const rowC = scan({
      identity: buildIdentityCandidate({
        deviceId: 9000,
        inode: 1,
        hash: { sizeBytes: 1, headHex: 'row-c-head', tailHex: 'row-c-tail' },
      }),
      path: '/media/movies/Third.mkv',
    });
    const claimedIdentity = buildIdentityCandidate({
      deviceId: 2049,
      inode: 555,
      hash: { sizeBytes: 1, headHex: 'cc', tailHex: 'dd' },
    });

    repo.updateAfterRun({
      fileId: rowC,
      identity: claimedIdentity,
      path: '/media/movies/Third.mkv',
      nlink: 1,
      sizeBytes: 1,
      mtimeMs: NOW + 1,
      ctimeMs: NOW + 1,
      container: 'mkv',
      nowMs: NOW + 1,
    });

    // Both A and B — every row that held the colliding inode_key — are
    // cleared, not just whichever one a `.get()` happened to return.
    expect(repo.getById(rowA)?.inode_key).toBeNull();
    expect(repo.getById('row-b')?.inode_key).toBeNull();
    // C now holds it, unambiguously.
    expect(repo.getById(rowC)?.inode_key).toBe(sharedInodeKey);
    expect(repo.identityLookup(LIB).byInodeKey(sharedInodeKey)).toBe(rowC);
  });

  it('lists a library, optionally filtered by state', () => {
    const a = scan();
    repo.setState({ fileId: a, state: 'good' });
    const b = scan({
      identity: buildIdentityCandidate({
        deviceId: 2049,
        inode: 43,
        hash: { ...hash, headHex: 'cc' },
      }),
      path: '/media/movies/Other.mkv',
    });
    repo.setState({ fileId: b, state: 'queued' });

    expect(repo.listByLibrary({ libraryId: LIB })).toHaveLength(2);
    expect(repo.listByLibrary({ libraryId: LIB, state: 'queued' }).map((r) => r.id)).toEqual([b]);
  });

  it('counts by state, reporting zero for states with no files', () => {
    const a = scan();
    repo.setState({ fileId: a, state: 'good' });
    const counts = repo.countsByState(LIB);
    expect(counts.good).toBe(1);
    expect(counts.queued).toBe(0);
    expect(counts.not_converging).toBe(0);
  });

  it('requeue clears both counters and returns the file to the queue', () => {
    const id = scan();
    repo.setLedger({
      fileId: id,
      record: {
        state: 'not_converging',
        signature: 'sig',
        attemptCount: 3,
        consecutiveNoopCount: 1,
        holdUntilMs: NOW,
      },
    });
    repo.requeue(id);
    expect(repo.getLedger(id)).toMatchObject({
      state: 'queued',
      attemptCount: 0,
      consecutiveNoopCount: 0,
      holdUntilMs: null,
    });
  });
});
