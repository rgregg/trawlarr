import { lstat, opendir } from 'node:fs/promises';
import type { LibraryRecord } from '../db/library-repo.js';
import type { MediaFileRepo, MediaFileRow } from '../db/media-file-repo.js';
import { pathContains } from '../fs/path-contains.js';

export interface ReconcileInput {
  library: LibraryRecord;
  mediaFileRepo: MediaFileRepo;
  /** Row ids this scan actually walked; those files are present by definition. */
  seenFileIds: ReadonlySet<string>;
  nowMs: number;
  /**
   * Treat a root that exists but contains nothing at all as available.
   *
   * OFF by default, because an empty directory is precisely what an
   * unmounted network share looks like (the mount point survives the mount),
   * and that shape is the one failure this design exists to prevent: a NAS
   * that is briefly offline must never make a whole library reconcile to
   * "everything is gone". A user who really did empty a root says so
   * explicitly with this flag.
   */
  allowEmptyRoots?: boolean;
  /** Seam for tests; defaults to `node:fs/promises` `lstat`. */
  statPath?: (path: string) => Promise<unknown>;
}

export interface ReconcileSummary {
  /** Rows newly marked missing by this pass. */
  missing: number;
  /** Roots not reconciled at all because they could not be shown to be present. */
  rootsUnavailable: number;
  /** Rows left alone because their absence could not be confirmed (not ENOENT). */
  unconfirmed: number;
}

const codeOf = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Is this root demonstrably THERE right now?
 *
 * Three answers, and only the first permits reconciliation under it:
 *
 *  - readable and non-empty: the mount is up and the directory is real.
 *  - readable and empty: indistinguishable from an unmounted network share,
 *    since the mount point outlives the mount. Refused unless the operator
 *    says otherwise (`allowEmptyRoots`).
 *  - unreadable/absent: an offline mount, a permission change, a typo in a
 *    root. Refused.
 *
 * `walkFiles` cannot answer this: it swallows an `opendir` failure and
 * skips the root silently (deliberately — one bad mount must not abort a
 * scan), so a scan of an offline library looks exactly like a scan of a
 * library whose files were all deleted. Reconciliation is the one caller
 * for which that difference is the whole question, so it asks separately.
 */
const rootIsAvailable = async (root: string, allowEmptyRoots: boolean): Promise<boolean> => {
  let dir;
  try {
    dir = await opendir(root);
  } catch {
    return false;
  }
  try {
    const first = await dir.read();
    return first !== null || allowEmptyRoots;
  } catch {
    return false;
  } finally {
    await dir.close().catch(() => {});
  }
};

/**
 * Reconcile the library's rows against the filesystem: find the ones whose
 * file is gone and mark them missing.
 *
 * Deleting the row was rejected. A row carries the file's whole history —
 * every job and step, its attempt counters, its original size — which is
 * exactly what a user wants to look at after an accidental deletion or a
 * botched move, and a DELETE cannot be undone by putting the file back
 * while a mark can (the next scan clears it). Marking also gives the two
 * things the deletion was wanted for: a missing row is excluded from
 * `countsByState`, so the convergence percentage describes files that
 * exist, and from `claimNext`, so a file that vanished while queued is
 * never handed to a worker.
 *
 * WHAT "MISSING" MEANS HERE — three independent confirmations, all required:
 *
 *  1. The row's root is available (see `rootIsAvailable`). One unavailable
 *     root disqualifies every row under it and nothing else; a multi-root
 *     library reconciles its healthy roots normally.
 *  2. The scan did not walk this row. (Not sufficient on its own: a file can
 *     go unwalked because the library's extensions changed, or because it
 *     sits under a directory the walk could not open.)
 *  3. `lstat` on the row's own recorded path fails with ENOENT
 *     specifically. Any other errno — EACCES on a directory this process
 *     cannot traverse, EIO, ESTALE or ENOTCONN from a mount that is going
 *     away underneath us — means "I could not check", which is never "it is
 *     gone". `lstat`, not `stat`: a dangling symlink is still a filesystem
 *     entry the user put there.
 *
 * Rows the pass never touches at all: anything already marked, anything
 * `running` (a replacement legitimately empties the old path mid-run), and
 * any row whose path is under none of the library's current roots — after a
 * root is reconfigured, that path says nothing about whether the file
 * exists where the library now looks.
 */
export const reconcileMissing = async (input: ReconcileInput): Promise<ReconcileSummary> => {
  const statPath = input.statPath ?? lstat;
  const summary: ReconcileSummary = { missing: 0, rootsUnavailable: 0, unconfirmed: 0 };

  const availableRoots: string[] = [];
  for (const root of input.library.roots) {
    if (await rootIsAvailable(root, input.allowEmptyRoots === true)) availableRoots.push(root);
    else summary.rootsUnavailable += 1;
  }
  if (availableRoots.length === 0) return summary;

  const candidates: MediaFileRow[] = input.mediaFileRepo
    .listByLibrary({ libraryId: input.library.id })
    .filter(
      (row) =>
        row.missing_since_ms === null &&
        row.state !== 'running' &&
        !input.seenFileIds.has(row.id) &&
        availableRoots.some((root) => pathContains(root, row.path)),
    );

  for (const row of candidates) {
    try {
      await statPath(row.path);
      continue; // The file is there; the walk simply did not yield it.
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') {
        summary.unconfirmed += 1;
        continue;
      }
    }
    if (
      input.mediaFileRepo.markMissing({ fileId: row.id, expectPath: row.path, nowMs: input.nowMs })
    )
      summary.missing += 1;
  }

  return summary;
};
