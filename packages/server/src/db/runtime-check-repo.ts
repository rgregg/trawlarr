import { RUNTIME_REFRESH_MS, RUNTIME_RETRY_MS } from '@trawlarr/core';
import type { Db } from './connection.js';

/** A file the background lookup should ask about next. */
export interface RuntimeDueFile {
  id: string;
  libraryId: string;
  path: string;
}

/** A file with both a known expected runtime and a measured duration. */
export interface RuntimeCandidate {
  id: string;
  libraryId: string;
  path: string;
  sizeBytes: number;
  state: string;
  durationMs: number;
  expectedRuntimeMs: number;
  expectedRuntimeSource: string | null;
  acceptedDurationMs: number | null;
}

export interface RuntimeCheckRepo {
  /**
   * Files whose expected runtime has never been looked up, or is stale — never
   * looked-up first. Files with no measured duration (nothing to compare) and
   * files confirmed gone from disk are left out.
   */
  listDue(input: { nowMs: number; libraryIds: string[]; limit: number }): RuntimeDueFile[];
  /** Store a lookup result; `expectedMs` null records "asked, not found". */
  record(input: {
    fileId: string;
    expectedMs: number | null;
    source: string | null;
    nowMs: number;
  }): void;
  /** Note an attempt that failed, keeping whatever expected runtime was already known. */
  touch(fileId: string, nowMs: number): void;
  /** Accept the file's CURRENT duration as its expected length. False when it has none. */
  accept(fileId: string): boolean;
  listCandidates(): RuntimeCandidate[];
}

interface CandidateRow {
  id: string;
  library_id: string;
  path: string;
  size_bytes: number;
  state: string;
  duration_ms: number;
  expected_runtime_ms: number;
  expected_runtime_source: string | null;
  accepted_duration_ms: number | null;
}

export const createRuntimeCheckRepo = (db: Db): RuntimeCheckRepo => ({
  listDue({ nowMs, libraryIds, limit }) {
    if (libraryIds.length === 0) return [];
    const marks = libraryIds.map(() => '?').join(', ');
    return (
      db
        .prepare(
          `SELECT id, library_id, path FROM media_file
            WHERE duration_ms IS NOT NULL
              AND missing_since_ms IS NULL
              AND library_id IN (${marks})
              AND (runtime_checked_at IS NULL
                   OR (expected_runtime_ms IS NULL AND runtime_checked_at <= ?)
                   OR (expected_runtime_ms IS NOT NULL AND runtime_checked_at <= ?))
            ORDER BY runtime_checked_at IS NOT NULL, runtime_checked_at, id
            LIMIT ?`,
        )
        .all(...libraryIds, nowMs - RUNTIME_RETRY_MS, nowMs - RUNTIME_REFRESH_MS, limit) as {
        id: string;
        library_id: string;
        path: string;
      }[]
    ).map((row) => ({ id: row.id, libraryId: row.library_id, path: row.path }));
  },

  record({ fileId, expectedMs, source, nowMs }) {
    db.prepare(
      `UPDATE media_file
          SET expected_runtime_ms = ?, expected_runtime_source = ?, runtime_checked_at = ?
        WHERE id = ?`,
    ).run(expectedMs, expectedMs === null ? null : source, nowMs, fileId);
  },

  touch(fileId, nowMs) {
    db.prepare(`UPDATE media_file SET runtime_checked_at = ? WHERE id = ?`).run(nowMs, fileId);
  },

  accept(fileId) {
    return (
      db
        .prepare(
          `UPDATE media_file SET accepted_duration_ms = duration_ms
            WHERE id = ? AND duration_ms IS NOT NULL`,
        )
        .run(fileId).changes > 0
    );
  },

  listCandidates() {
    return (
      db
        .prepare(
          `SELECT id, library_id, path, size_bytes, state, duration_ms,
                  expected_runtime_ms, expected_runtime_source, accepted_duration_ms
             FROM media_file
            WHERE expected_runtime_ms IS NOT NULL
              AND duration_ms IS NOT NULL
              AND missing_since_ms IS NULL
            ORDER BY path`,
        )
        .all() as CandidateRow[]
    ).map((row) => ({
      id: row.id,
      libraryId: row.library_id,
      path: row.path,
      sizeBytes: row.size_bytes,
      state: row.state,
      durationMs: row.duration_ms,
      expectedRuntimeMs: row.expected_runtime_ms,
      expectedRuntimeSource: row.expected_runtime_source,
      acceptedDurationMs: row.accepted_duration_ms,
    }));
  },
});
