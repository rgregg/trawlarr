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
  setProbe(input: { fileId: string; probe: ProbeData; facts: FactSet }): void;
  setLedger(input: {
    fileId: string;
    record: LedgerRecord;
    preFacts?: FactSet | null;
    postFacts?: FactSet | null;
    lastRunId?: string | null;
  }): void;
  getLedger(fileId: string): LedgerRecord | null;
  getProbe(fileId: string): { probe: ProbeData; facts: FactSet } | null;
  listByLibrary(input: { libraryId: string; state?: FileState }): MediaFileRow[];
  requeue(fileId: string): void;
  countsByState(libraryId: string): Record<FileState, number>;
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

const ALL_STATES: readonly FileState[] = [
  'unknown',
  'queued',
  'running',
  'good',
  'failed',
  'not_converging',
  'held',
];

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
        .prepare(`SELECT state, COUNT(*) AS c FROM media_file WHERE library_id = ? GROUP BY state`)
        .all(libraryId) as Array<{ state: FileState; c: number }>;
      for (const row of rows) counts[row.state] = row.c;
      return counts;
    },
  };
};
