import type { FileState, FlowDefinition, HardwareType, WorkerClass } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import type { Db } from '../db/connection.js';
import { createMediaFileRepo, type ClaimedFile } from '../db/media-file-repo.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createFlowRepo } from '../db/flow-repo.js';

/**
 * Everything running one job needs, as plain data.
 *
 * The whole point of this shape is that it is the ONLY thing a run receives:
 * once a payload is built, `runPayload` needs no database handle, so a job
 * can run in a process that has none (Task 5 forks one). That is only true
 * if every database-derived fact a run consults is captured HERE, at a
 * single moment, rather than re-read later — which is also why the facts a
 * run judges itself against are extracted from these fields (see
 * `runPayload`'s `preFacts`) rather than through
 * `MediaFileRepo.getProbe`, whose "facts as of now" silently follow the
 * row's later mutations.
 *
 * Every field must survive `JSON.parse(JSON.stringify(payload))` unchanged:
 * no `Date`, no `Buffer`, no `undefined` in a position that matters. A
 * structured-clone-only field would type-check here and then quietly arrive
 * as something else on the far side of the IPC boundary.
 */
export interface JobPayload {
  jobId: string;
  fileId: string;
  libraryId: string;
  path: string;
  container: string;
  sizeBytes: number;
  originalSizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  /**
   * Trawlarr's stable identity, not the path (spec 4.2): inode first,
   * falling back to the content-hash key for a file with no stat inode
   * (should not happen for a real file, but the row can technically hold
   * one without the other mid-scan).
   */
  footprintId: string;
  state: FileState;
  holdUntilMs: number | null;
  discoveredAtMs: number;
  probe: ProbeData;
  library: LibraryRecord;
  flow: { id: string; definition: FlowDefinition; definitionHash: string };
  workerClass: WorkerClass;
  hardwareType: HardwareType;
  ffmpegPath: string;
  ffprobePath: string;
}

export interface BuildJobPayloadInput {
  db: Db;
  claimed: ClaimedFile;
  jobId: string;
  /**
   * Run THIS flow instead of the one the library is attached to.
   *
   * The only caller is the dry-run endpoint, which is asked to walk a
   * specific flow against a specific file — including a flow the library is
   * not (yet) using, and including a library with no flow attached at all,
   * which is exactly the case someone reaches for a dry run to get out of.
   * A real job never sets this: the flow a library converges against is the
   * library's own, and letting a caller substitute one would make the
   * `flow_hash` recorded on the job row a fiction.
   */
  flow?: { id: string; definition: FlowDefinition; definitionHash: string };
  workerClass: WorkerClass;
  hardwareType: HardwareType;
  ffmpegPath: string;
  ffprobePath: string;
}

/**
 * Reads the database once and produces the run's whole input.
 *
 * Writes nothing. Throws a NAMED error — one that says which of the row,
 * library, flow or probe is missing — rather than something anonymous,
 * because this error is what an operator sees as the job's outcome text
 * when a library is reconfigured mid-flight, and "Unhandled error:
 * undefined" is not an answer to "why is this file held?".
 */
export const buildJobPayload = (input: BuildJobPayloadInput): JobPayload => {
  const row = createMediaFileRepo(input.db).getById(input.claimed.fileId);
  if (row === null) throw new Error(`Claimed file ${input.claimed.fileId} does not exist.`);

  const library = createLibraryRepo(input.db).getById(input.claimed.libraryId);
  if (library === null) {
    throw new Error(`Claimed file's library ${input.claimed.libraryId} does not exist.`);
  }

  const flow = ((): { id: string; definition: FlowDefinition; definitionHash: string } => {
    if (input.flow !== undefined) return input.flow;
    if (library.flowId === null) {
      throw new Error(`Library "${library.name}" has no flow attached; nothing to run.`);
    }
    const attached = createFlowRepo(input.db).getById(library.flowId);
    if (attached === null) {
      throw new Error(`Library "${library.name}" references unknown flow ${library.flowId}.`);
    }
    return attached;
  })();

  const probe = row.probe_json === null ? null : (JSON.parse(row.probe_json) as ProbeData);
  if (probe === null) {
    throw new Error(`File ${row.id} has never been probed; cannot compute a signature for it.`);
  }

  return {
    jobId: input.jobId,
    fileId: row.id,
    libraryId: library.id,
    path: row.path,
    container: row.container,
    sizeBytes: row.size_bytes,
    originalSizeBytes: row.original_size_bytes ?? row.size_bytes,
    mtimeMs: row.mtime_ms,
    ctimeMs: row.ctime_ms,
    footprintId: row.inode_key ?? row.content_key,
    state: row.state,
    holdUntilMs: row.hold_until_ms,
    discoveredAtMs: row.discovered_at,
    probe,
    library,
    flow: { id: flow.id, definition: flow.definition, definitionHash: flow.definitionHash },
    workerClass: input.workerClass,
    hardwareType: input.hardwareType,
    ffmpegPath: input.ffmpegPath,
    ffprobePath: input.ffprobePath,
  };
};
