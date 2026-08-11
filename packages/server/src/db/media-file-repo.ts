import { randomUUID } from 'node:crypto';
import type { FileState, IdentityCandidate, IdentityLookup } from '@trawlarr/core';
import type { Db } from './connection.js';

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
  state: FileState;
  signature: string | null;
  attempt_count: number;
  consecutive_noop_count: number;
  hold_until_ms: number | null;
  priority: number;
  discovered_at: number;
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
}

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
      const existing =
        (input.identity.inodeKey !== null ? lookup.byInodeKey(input.identity.inodeKey) : null) ??
        lookup.byContentKey(input.identity.contentKey);

      if (existing !== null) {
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
        return existing;
      }

      const id = randomUUID();
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
  };
};
