import type { Db } from '../db/connection.js';
import { createFlowRepo } from '../db/flow-repo.js';
import type { LibraryRecord } from '../db/library-repo.js';
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  purgeTrash,
  trashRetentionDaysForFlow,
  type TrashSweepSummary,
} from './trash.js';

export interface SweepLibraryTrashInput {
  db: Db;
  library: LibraryRecord;
  /** Override the retention the library's flow declares, for this sweep only. */
  days?: number;
  nowMs: number;
  /** Report what would go, remove nothing. */
  dryRun?: boolean;
}

export interface LibraryTrashSweep {
  libraryId: string;
  libraryName: string;
  /** The retention actually applied, whatever its source. */
  retentionDays: number;
  dryRun: boolean;
  summary: TrashSweepSummary;
}

/**
 * Sweep one library's trash, RESOLVING THE RETENTION THE ONE WAY IT IS
 * DEFINED: the longest `trashRetentionDays` any Replace Original File node in
 * the library's own flow declares, falling back to that node's declared
 * default when the library has no flow.
 *
 * This lives here — not inside the CLI, and not inside the API — because both
 * of them sweep, and a retention resolved two ways is a retention that will
 * eventually differ between them. Being wrong in that direction deletes a
 * user's only remaining copy of a file: the trash is the recovery path for
 * every failure in the destructive layer. So the CLI's `trawlarr trash purge`
 * and `POST /system/maintenance/trash-purge` call exactly this function, and
 * differ only in how they PRESENT the summary it returns.
 */
export const sweepLibraryTrash = async (
  input: SweepLibraryTrashInput,
): Promise<LibraryTrashSweep> => {
  const { db, library } = input;
  const flow = library.flowId === null ? null : createFlowRepo(db).getById(library.flowId);
  const retentionDays =
    input.days ??
    (flow === null ? DEFAULT_TRASH_RETENTION_DAYS : trashRetentionDaysForFlow(flow.definition));

  const summary = await purgeTrash({
    library,
    retentionDays,
    nowMs: input.nowMs,
    dryRun: input.dryRun,
  });

  return {
    libraryId: library.id,
    libraryName: library.name,
    retentionDays,
    dryRun: input.dryRun === true,
    summary,
  };
};
