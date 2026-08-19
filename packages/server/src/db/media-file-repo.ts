import { randomUUID } from 'node:crypto';
import type {
  FactSet,
  FileState,
  IdentityCandidate,
  IdentityLookup,
  LedgerRecord,
} from '@trawlarr/core';
import { applyRequeue, extractFacts } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import type { Db } from './connection.js';

/**
 * Raised in place of a raw SqliteError when a UNIQUE (library_id, content_key)
 * violation still somehow escapes the conflict resolution in `upsertScanned`.
 * A scan must never be aborted by a single pathological file: callers (the
 * scanner's chunked loop) can catch this named error, skip the offending
 * file, and continue with the rest of the library.
 */
export class IdentityConflictError extends Error {
  readonly libraryId: string;
  readonly contentKey: string;

  constructor(libraryId: string, contentKey: string, cause?: unknown) {
    super(
      `Identity conflict in library ${libraryId}: content key ${contentKey} is already owned by another row`,
    );
    this.name = 'IdentityConflictError';
    this.libraryId = libraryId;
    this.contentKey = contentKey;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface MediaFileRow {
  id: string;
  library_id: string;
  inode_key: string | null;
  content_key: string;
  path: string;
  nlink: number;
  size_bytes: number;
  mtime_ms: number;
  ctime_ms: number;
  container: string;
  probe_json: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  resolution: string | null;
  duration_ms: number | null;
  bitrate: number | null;
  state: FileState;
  signature: string | null;
  attempt_count: number;
  consecutive_noop_count: number;
  hold_until_ms: number | null;
  pre_facts_json: string | null;
  post_facts_json: string | null;
  original_size_bytes: number | null;
  last_run_id: string | null;
  priority: number;
  discovered_at: number;
  updated_at: number;
  /**
   * When a scan first confirmed this row's file was gone from disk, or NULL
   * while the file is present. See `003_media_file_missing.sql`: a missing
   * row keeps all of its history but is excluded from `countsByState` (the
   * convergence percentage describes files that exist) and from `claimNext`
   * (a file that vanished while queued is never handed to a worker).
   */
  missing_since_ms: number | null;
}

export interface UpsertScannedInput {
  libraryId: string;
  identity: IdentityCandidate;
  path: string;
  nlink: number;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  container: string;
  nowMs: number;
}

export interface ClaimedFile {
  fileId: string;
  libraryId: string;
  path: string;
}

export interface QueryFilesInput {
  libraryId?: string;
  state?: FileState;
  /** true: only rows whose file is confirmed gone. false: only rows whose file is present. */
  missing?: boolean;
  /** Substring match on the row's path, matched literally (LIKE wildcards are escaped). */
  q?: string;
  limit: number;
  offset: number;
}

export interface MediaFilePage {
  total: number;
  items: MediaFileRow[];
}

export interface UpdateAfterRunInput {
  fileId: string;
  identity: IdentityCandidate;
  path: string;
  nlink: number;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  container: string;
  nowMs: number;
}

export interface MediaFileRepo {
  identityLookup(libraryId: string): IdentityLookup;
  upsertScanned(input: UpsertScannedInput): string;
  claimNext(input: {
    workerClass: string;
    nowMs: number;
    libraryIds?: string[];
  }): ClaimedFile | null;
  setState(input: {
    fileId: string;
    state: FileState;
    signature?: string | null;
    attemptCount?: number;
    consecutiveNoopCount?: number;
    holdUntilMs?: number | null;
  }): void;
  getById(fileId: string): MediaFileRow | null;
  /**
   * Stores `probe_json` verbatim and derives the denormalised filter columns
   * (`video_codec`, `audio_codec`, `resolution`, `duration_ms`, `bitrate`)
   * from `facts`. The `facts` argument itself is NOT persisted — the schema
   * has no column for a scan-time fact set — so it only ever influences
   * these five columns. See `getProbe` for what that means for callers that
   * later ask for "the facts as of this probe".
   */
  setProbe(input: { fileId: string; probe: ProbeData; facts: FactSet }): void;
  setLedger(input: {
    fileId: string;
    record: LedgerRecord;
    preFacts?: FactSet | null;
    postFacts?: FactSet | null;
    lastRunId?: string | null;
  }): void;
  getLedger(fileId: string): LedgerRecord | null;
  /**
   * Returns the stored `probe_json` and a `FactSet` recomputed from it
   * against the row's CURRENT `container` and `size_bytes` — not the ones
   * in effect when `setProbe` was last called. If nothing has touched the
   * row since, this is identical to the fact set `setProbe` was given. But
   * `upsertScanned` can change `container`/`size_bytes` on a rescan without
   * a re-probe (e.g. before the file is queued for probing again), and this
   * method does not notice: it always answers "facts as of now, read
   * through the last stored probe", never "facts as of probe time". A
   * caller that needs the latter must extract facts itself from the probe
   * it already has in hand rather than trusting this method.
   */
  getProbe(fileId: string): { probe: ProbeData; facts: FactSet } | null;
  /**
   * Overwrite a KNOWN row's identity and stat columns (`inode_key`,
   * `content_key`, `path`, `nlink`, `size_bytes`, `mtime_ms`, `ctime_ms`,
   * `container`) after a run has changed what is actually on disk at this
   * file's path — most notably, after Replace Original File swaps in a new
   * inode with different content.
   *
   * This is deliberately NOT `upsertScanned`: that method's whole job is to
   * MATCH a freshly-walked file against an existing row by identity, and a
   * replaced file's new identity (new inode, new content hash) cannot match
   * its own row's now-stale one — that mismatch is exactly what made every
   * scan after a run treat the file as brand new and open a second row,
   * forever, rather than recognising the row a job already owns. Called by
   * `fileId`, which the caller already knows, this updates that exact row in
   * place instead of searching for one.
   *
   * Skipping this call (or calling it with anything other than what the
   * replaced file's own stat and content hash report) reopens the same bug:
   * the next scan's identity lookup misses this row, inserts a new one, and
   * the file never reaches `alreadyGood`.
   */
  updateAfterRun(input: UpdateAfterRunInput): void;
  listByLibrary(input: { libraryId: string; state?: FileState }): MediaFileRow[];
  /**
   * Filtered, paginated rows plus the TOTAL the filter matched.
   *
   * The only listing an API should ever expose: a real library is 100,000
   * rows, and `listByLibrary` (which returns all of them) is a query for
   * batch code that is about to iterate, not for a request/response boundary.
   * `total` is separate from the page so a client can tell "last page" from
   * "the page size happened to match".
   */
  query(input: QueryFilesInput): MediaFilePage;
  /**
   * The library paths of rows that are `running` RIGHT NOW — the files some
   * worker has claimed and may be part-way through replacing.
   *
   * Read fresh per walked file by the scanner (never cached for the length
   * of a scan): a run claims its row — committing `running` — strictly
   * before it can put a replacement on disk, so a file the scanner can
   * already see is guaranteed to be covered by a `running` row that was
   * committed before it existed. Caching this set at scan start would break
   * exactly that guarantee for a job that started mid-scan.
   */
  listRunningPaths(libraryId: string): string[];
  requeue(fileId: string): void;
  /**
   * Files in this library, by ledger state, EXCLUDING rows whose file is
   * missing from disk. The convergence percentage the CLI reports is
   * `good / total` over this map, and a row for a file that no longer
   * exists can never reach `good` — counting it would cap a library's
   * convergence below 100% permanently for a file the user deliberately
   * deleted. `missingCount` reports those separately.
   */
  countsByState(libraryId: string): Record<FileState, number>;
  /** How many of this library's rows are currently marked missing on disk. */
  missingCount(libraryId: string): number;
  listMissing(libraryId: string): MediaFileRow[];
  /**
   * Record that this row's file is gone, if the row still looks exactly the
   * way the caller found it.
   *
   * The re-checks are the point, and they run inside the write transaction:
   * a scan takes minutes, and between deciding a path was absent and writing
   * that decision, a worker can claim the row (`claimNext` commits `running`
   * before it touches the filesystem) or a replacement can move it. Both
   * shapes legitimately leave the OLD path empty, and marking either of them
   * missing would take a live file out of the convergence count. Returns
   * whether the mark was actually applied.
   */
  markMissing(input: { fileId: string; expectPath: string; nowMs: number }): boolean;
  /** The file is back: clear the mark. A no-op when it was never set. */
  clearMissing(fileId: string): void;
}

const RESOLUTION_LABELS: ReadonlyArray<{ minWidth: number; label: string }> = [
  { minWidth: 7000, label: '8KUHD' },
  { minWidth: 3000, label: '4KUHD' },
  { minWidth: 1800, label: '1080p' },
  { minWidth: 1200, label: '720p' },
  { minWidth: 1000, label: '576p' },
  { minWidth: 700, label: '480p' },
];

/** Matches the `video_resolution` vocabulary community plugins compare against. */
const resolutionOf = (width: number | null): string | null => {
  if (width === null) return null;
  return RESOLUTION_LABELS.find((entry) => width >= entry.minWidth)?.label ?? 'other';
};

/** ffprobe reports bit_rate as a numeric string; the column is an integer. */
const numericBitrate = (probe: ProbeData): number | null => {
  const raw = probe.format?.bit_rate;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Every `FileState`, zero-filled by `countsByState`. `FileState` (in
 * `@trawlarr/core`) is a bare union with no exported canonical array, so
 * this list is hand-maintained — the `satisfies Record<FileState, true>`
 * below is a compile-time tripwire: adding a state to the union without
 * adding it here (or vice versa) is a type error, not a silently
 * under-reporting dashboard.
 */
const ALL_STATES_MAP = {
  unknown: true,
  queued: true,
  running: true,
  good: true,
  failed: true,
  not_converging: true,
  held: true,
} satisfies Record<FileState, true>;

/** Every `FileState`, in a stable order — exported for the CLI's own validation. */
export const ALL_STATES: readonly FileState[] = Object.keys(ALL_STATES_MAP) as FileState[];

const isUniqueConstraintError = (err: unknown): boolean =>
  err instanceof Error &&
  err.name === 'SqliteError' &&
  'code' in err &&
  (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';

/**
 * Belt-and-braces: if a UNIQUE (library_id, content_key) violation still
 * somehow reaches the database despite the conflict resolution above,
 * translate it into a named, catchable error instead of letting a raw
 * SqliteError propagate and abort the whole scan.
 */
const toIdentityConflictError = (err: unknown, libraryId: string, contentKey: string): unknown =>
  isUniqueConstraintError(err) ? new IdentityConflictError(libraryId, contentKey, err) : err;

export const createMediaFileRepo = (db: Db): MediaFileRepo => {
  const byInode = db.prepare(`SELECT id FROM media_file WHERE library_id = ? AND inode_key = ?`);
  const byContent = db.prepare(
    `SELECT id FROM media_file WHERE library_id = ? AND content_key = ?`,
  );
  const selectById = db.prepare(`SELECT * FROM media_file WHERE id = ?`);
  const runningPaths = db.prepare(
    `SELECT path FROM media_file WHERE library_id = ? AND state = 'running'`,
  );

  const insertFile = db.prepare(
    `INSERT INTO media_file (
       id, library_id, inode_key, content_key, path, nlink,
       size_bytes, mtime_ms, ctime_ms, container,
       state, original_size_bytes, discovered_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)`,
  );

  const updateScanned = db.prepare(
    `UPDATE media_file
        SET inode_key = ?, content_key = ?, path = ?, nlink = ?,
            size_bytes = ?, mtime_ms = ?, ctime_ms = ?, container = ?, updated_at = ?
      WHERE id = ?`,
  );

  const clearInodeKey = db.prepare(
    `UPDATE media_file SET inode_key = NULL, updated_at = ? WHERE id = ?`,
  );

  const markMissingStatement = db.prepare(
    `UPDATE media_file SET missing_since_ms = ? WHERE id = ?`,
  );

  const clearMissingStatement = db.prepare(
    `UPDATE media_file SET missing_since_ms = NULL WHERE id = ?`,
  );

  /**
   * Claim in one statement. A read-then-write queue lets two workers select
   * the same row and transcode it twice into each other's output, so the
   * SELECT that picks the row and the UPDATE that takes it must be atomic.
   */
  const claimStatement = db.prepare(
    `UPDATE media_file
        SET state = 'running', updated_at = :nowMs
      WHERE id = (
        SELECT id FROM media_file
         WHERE state IN ('queued', 'held')
           -- A file the scanner has confirmed gone is not work: claiming it
           -- would spend an attempt (and a backoff, and eventually a
           -- terminal failure) on a file nothing can process. The mark is
           -- cleared the moment the file comes back, and the row's ledger
           -- state is untouched meanwhile, so it resumes exactly here.
           AND missing_since_ms IS NULL
           AND (hold_until_ms IS NULL OR hold_until_ms < :nowMs)
           AND (:filterLibraries = 0 OR library_id IN (SELECT value FROM json_each(:libraryIds)))
         ORDER BY priority DESC, discovered_at ASC
         LIMIT 1
      )
      RETURNING id AS fileId, library_id AS libraryId, path`,
  );

  const identityLookup = (libraryId: string): IdentityLookup => ({
    byInodeKey: (key) => (byInode.get(libraryId, key) as { id: string } | undefined)?.id ?? null,
    byContentKey: (key) =>
      (byContent.get(libraryId, key) as { id: string } | undefined)?.id ?? null,
  });

  return {
    identityLookup,

    upsertScanned(input) {
      const lookup = identityLookup(input.libraryId);
      const inodeMatch =
        input.identity.inodeKey !== null ? lookup.byInodeKey(input.identity.inodeKey) : null;
      const contentMatch = lookup.byContentKey(input.identity.contentKey);

      // Bytes are the authoritative identity (the same premise behind the
      // content-hash fallback). If the inode match and the content match
      // land on different rows, the file's bytes now belong to the
      // content-matched row, so it wins. The inode-matched row loses its
      // now-stale inode_key so it cannot keep colliding with this content
      // key on every future scan.
      const existing =
        inodeMatch !== null && contentMatch !== null && inodeMatch !== contentMatch
          ? contentMatch
          : (inodeMatch ?? contentMatch);

      if (existing !== null) {
        if (inodeMatch !== null && inodeMatch !== existing) {
          clearInodeKey.run(input.nowMs, inodeMatch);
        }

        try {
          updateScanned.run(
            input.identity.inodeKey,
            input.identity.contentKey,
            input.path,
            input.nlink,
            input.sizeBytes,
            input.mtimeMs,
            input.ctimeMs,
            input.container,
            input.nowMs,
            existing,
          );
        } catch (err) {
          throw toIdentityConflictError(err, input.libraryId, input.identity.contentKey);
        }
        return existing;
      }

      const id = randomUUID();
      try {
        insertFile.run(
          id,
          input.libraryId,
          input.identity.inodeKey,
          input.identity.contentKey,
          input.path,
          input.nlink,
          input.sizeBytes,
          input.mtimeMs,
          input.ctimeMs,
          input.container,
          input.sizeBytes,
          input.nowMs,
          input.nowMs,
        );
      } catch (err) {
        throw toIdentityConflictError(err, input.libraryId, input.identity.contentKey);
      }
      return id;
    },

    claimNext(input) {
      const filterLibraries = input.libraryIds === undefined ? 0 : 1;
      const row = claimStatement.get({
        nowMs: input.nowMs,
        filterLibraries,
        libraryIds: JSON.stringify(input.libraryIds ?? []),
      }) as ClaimedFile | undefined;
      return row ?? null;
    },

    setState(input) {
      const current = selectById.get(input.fileId) as MediaFileRow | undefined;
      if (current === undefined) throw new Error(`Unknown media file: ${input.fileId}`);

      db.prepare(
        `UPDATE media_file
            SET state = ?, signature = ?, attempt_count = ?,
                consecutive_noop_count = ?, hold_until_ms = ?
          WHERE id = ?`,
      ).run(
        input.state,
        input.signature === undefined ? current.signature : input.signature,
        input.attemptCount ?? current.attempt_count,
        input.consecutiveNoopCount ?? current.consecutive_noop_count,
        input.holdUntilMs === undefined ? current.hold_until_ms : input.holdUntilMs,
        input.fileId,
      );
    },

    getById(fileId) {
      return (selectById.get(fileId) as MediaFileRow | undefined) ?? null;
    },

    // `input.facts` is used ONLY to derive the five denormalised columns
    // below; it is never itself written to a column (there is no schema
    // column for it). See the `setProbe` doc comment on the interface.
    setProbe(input) {
      db.prepare(
        `UPDATE media_file
            SET probe_json = ?, video_codec = ?, audio_codec = ?,
                resolution = ?, duration_ms = ?, bitrate = ?
          WHERE id = ?`,
      ).run(
        JSON.stringify(input.probe),
        input.facts.streams.find((s) => s.codecType === 'video')?.codecName ?? null,
        input.facts.streams.find((s) => s.codecType === 'audio')?.codecName ?? null,
        resolutionOf(input.facts.width),
        input.facts.durationMs,
        numericBitrate(input.probe),
        input.fileId,
      );
    },

    // Recomputes facts from the stored probe against the row's CURRENT
    // container/size_bytes, not the values in effect when setProbe was
    // called — see the `getProbe` doc comment on the interface for why that
    // can diverge from "facts as of probe time" and what callers who need
    // the latter must do instead.
    getProbe(fileId) {
      const current = selectById.get(fileId) as MediaFileRow | undefined;
      if (current === undefined || current.probe_json === null) return null;
      const probe = JSON.parse(current.probe_json) as ProbeData;
      const facts = extractFacts({
        probe,
        container: current.container,
        sizeBytes: current.size_bytes,
      });
      return { probe, facts };
    },

    updateAfterRun(input) {
      const current = selectById.get(input.fileId) as MediaFileRow | undefined;
      if (current === undefined) throw new Error(`Unknown media file: ${input.fileId}`);

      // Run as one transaction: a caller that also calls `setProbe` for the
      // same run (as `runJob` does) wraps that call together with this one
      // in its own outer transaction, and better-sqlite3 nests transactions
      // as savepoints — so a conflict below rolls back BOTH writes, not just
      // this one. Without that, a thrown IdentityConflictError here would
      // leave `setProbe`'s write already committed: the row would carry the
      // NEW probe/codec columns but the OLD inode_key/content_key/path/
      // size_bytes — exactly the split state this whole mechanism exists to
      // prevent, just moved one level down.
      db.transaction(() => {
        // A freshly-replaced file's inode is a NEW one from the kernel's
        // perspective, and inode numbers are recycled after deletion — so it
        // can coincide with the inode_key some OTHER row in this library
        // recorded for a file that has since been deleted or replaced.
        // `inode_key` carries no UNIQUE constraint at the schema level (only
        // `content_key` does), so writing it here without checking would
        // silently leave two rows claiming the same inode_key, and a future
        // scan's `byInodeKey` lookup would be ambiguous between them —
        // matching a rename to the wrong file's row. Mirrors the same
        // defensive clear `upsertScanned` already does for exactly this
        // reason.
        //
        // `.all()`, not `.get()`: there is only an index on
        // (library_id, inode_key), not a UNIQUE constraint, so more than one
        // row can already share the incoming inode_key (possible
        // historically, before this clearing existed). Clearing only the
        // first one `.get()` happened to return would leave the lookup
        // still ambiguous between whichever row was missed and this one.
        if (input.identity.inodeKey !== null) {
          const colliding = byInode.all(current.library_id, input.identity.inodeKey) as {
            id: string;
          }[];
          for (const row of colliding) {
            if (row.id !== input.fileId) clearInodeKey.run(input.nowMs, row.id);
          }
        }

        // Same column set and shape as the identity-matched branch of
        // `upsertScanned` — this is the same "what does this row's file
        // look like now" update, just addressed by the id the caller
        // already knows rather than by searching for it.
        try {
          updateScanned.run(
            input.identity.inodeKey,
            input.identity.contentKey,
            input.path,
            input.nlink,
            input.sizeBytes,
            input.mtimeMs,
            input.ctimeMs,
            input.container,
            input.nowMs,
            input.fileId,
          );
        } catch (err) {
          throw toIdentityConflictError(err, current.library_id, input.identity.contentKey);
        }
      })();
    },

    setLedger(input) {
      const current = selectById.get(input.fileId) as MediaFileRow | undefined;
      if (current === undefined) throw new Error(`Unknown media file: ${input.fileId}`);

      db.prepare(
        `UPDATE media_file
            SET state = ?, signature = ?, attempt_count = ?,
                consecutive_noop_count = ?, hold_until_ms = ?,
                pre_facts_json = ?, post_facts_json = ?, last_run_id = ?
          WHERE id = ?`,
      ).run(
        input.record.state,
        input.record.signature,
        input.record.attemptCount,
        input.record.consecutiveNoopCount,
        input.record.holdUntilMs,
        input.preFacts === undefined
          ? current.pre_facts_json
          : input.preFacts === null
            ? null
            : JSON.stringify(input.preFacts),
        input.postFacts === undefined
          ? current.post_facts_json
          : input.postFacts === null
            ? null
            : JSON.stringify(input.postFacts),
        input.lastRunId === undefined ? current.last_run_id : input.lastRunId,
        input.fileId,
      );
    },

    getLedger(fileId) {
      const row = selectById.get(fileId) as MediaFileRow | undefined;
      if (row === undefined) return null;
      return {
        state: row.state,
        signature: row.signature,
        attemptCount: row.attempt_count,
        consecutiveNoopCount: row.consecutive_noop_count,
        holdUntilMs: row.hold_until_ms,
      };
    },

    listByLibrary(input) {
      if (input.state === undefined) {
        return db
          .prepare(`SELECT * FROM media_file WHERE library_id = ?`)
          .all(input.libraryId) as MediaFileRow[];
      }
      return db
        .prepare(`SELECT * FROM media_file WHERE library_id = ? AND state = ?`)
        .all(input.libraryId, input.state) as MediaFileRow[];
    },

    query(input) {
      // One where clause, used by both statements: a total describing a
      // different filter than the rows is worse than no total at all.
      const where: string[] = [];
      const params: unknown[] = [];
      if (input.libraryId !== undefined) {
        where.push(`library_id = ?`);
        params.push(input.libraryId);
      }
      if (input.state !== undefined) {
        where.push(`state = ?`);
        params.push(input.state);
      }
      if (input.missing !== undefined) {
        where.push(input.missing ? `missing_since_ms IS NOT NULL` : `missing_since_ms IS NULL`);
      }
      if (input.q !== undefined && input.q !== '') {
        // A user searching for a literal '%' or '_' in a path (both legal in
        // a filename) must not silently get a wildcard match.
        where.push(`path LIKE ? ESCAPE '\\'`);
        params.push(`%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      }
      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
      const total = (
        db.prepare(`SELECT COUNT(*) AS c FROM media_file ${clause}`).get(...params) as { c: number }
      ).c;
      const items = db
        .prepare(`SELECT * FROM media_file ${clause} ORDER BY path ASC, id ASC LIMIT ? OFFSET ?`)
        .all(...params, input.limit, input.offset) as MediaFileRow[];
      return { total, items };
    },

    listRunningPaths(libraryId) {
      return (runningPaths.all(libraryId) as { path: string }[]).map((row) => row.path);
    },

    requeue(fileId) {
      const current = selectById.get(fileId) as MediaFileRow | undefined;
      if (current === undefined) throw new Error(`Unknown media file: ${fileId}`);
      const record: LedgerRecord = {
        state: current.state,
        signature: current.signature,
        attemptCount: current.attempt_count,
        consecutiveNoopCount: current.consecutive_noop_count,
        holdUntilMs: current.hold_until_ms,
      };
      const requeued = applyRequeue(record);
      db.prepare(
        `UPDATE media_file
            SET state = ?, attempt_count = ?, consecutive_noop_count = ?, hold_until_ms = ?
          WHERE id = ?`,
      ).run(
        requeued.state,
        requeued.attemptCount,
        requeued.consecutiveNoopCount,
        requeued.holdUntilMs,
        fileId,
      );
    },

    countsByState(libraryId) {
      const counts = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<FileState, number>;
      const rows = db
        .prepare(
          `SELECT state, COUNT(*) AS c FROM media_file
            WHERE library_id = ? AND missing_since_ms IS NULL
            GROUP BY state`,
        )
        .all(libraryId) as Array<{ state: FileState; c: number }>;
      for (const row of rows) counts[row.state] = row.c;
      return counts;
    },

    missingCount(libraryId) {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM media_file
              WHERE library_id = ? AND missing_since_ms IS NOT NULL`,
          )
          .get(libraryId) as { c: number }
      ).c;
    },

    listMissing(libraryId) {
      return db
        .prepare(`SELECT * FROM media_file WHERE library_id = ? AND missing_since_ms IS NOT NULL`)
        .all(libraryId) as MediaFileRow[];
    },

    markMissing(input) {
      return db.transaction((): boolean => {
        const current = selectById.get(input.fileId) as MediaFileRow | undefined;
        if (current === undefined) return false;
        // Already marked: keep the ORIGINAL discovery time rather than
        // sliding it forward on every scan, so "missing since" means what
        // it says.
        if (current.missing_since_ms !== null) return false;
        // A worker claimed it after the check: `Replace Original File`
        // legitimately empties the old path mid-run, and the run records the
        // new one moments later.
        if (current.state === 'running') return false;
        // The row moved to a different path after the check (a rename picked
        // up by a concurrent scan, or a run's `updateAfterRun`): the absence
        // that was observed is no longer this row's absence.
        if (current.path !== input.expectPath) return false;
        markMissingStatement.run(input.nowMs, input.fileId);
        return true;
      })();
    },

    clearMissing(fileId) {
      clearMissingStatement.run(fileId);
    },
  };
};
