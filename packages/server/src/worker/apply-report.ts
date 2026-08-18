import {
  applyRunOutcome,
  applyStall,
  buildIdentityCandidate,
  computeSignature,
  newLedgerRecord,
  type FactSet,
  type FileState,
  type IdentityCandidate,
  type LedgerRecord,
  type RunOutcome,
} from '@trawlarr/core';
import type { Db } from '../db/connection.js';
import {
  createMediaFileRepo,
  IdentityConflictError,
  type MediaFileRow,
} from '../db/media-file-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import type { JobPayload } from './job-payload.js';
import type { JobReport, ReplacedFile } from './run-payload.js';

/** What a database-side fold reports back: the state the file landed in. */
export interface AppliedOutcome {
  state: FileState;
}

const identityOf = (replaced: ReplacedFile): IdentityCandidate =>
  buildIdentityCandidate({
    deviceId: replaced.deviceId,
    inode: replaced.inode,
    hash: replaced.hash,
  });

/**
 * Stall one attempt: back the file off and close its job row as failed.
 *
 * Shared by `applyJobFailure` (an attempt that produced no report) and
 * `applyThrownFailure` (an attempt that threw), so the two can never drift
 * apart on the one property that matters — the row leaves `running`.
 */
const stallAttempt = (input: {
  db: Db;
  fileId: string;
  jobId: string;
  reason: string;
  nowMs: () => number;
}): AppliedOutcome => {
  const mediaFileRepo = createMediaFileRepo(input.db);
  const ledger = mediaFileRepo.getLedger(input.fileId) ?? newLedgerRecord();
  const stalled = applyStall({ record: ledger, nowMs: input.nowMs() });

  mediaFileRepo.setLedger({ fileId: input.fileId, record: stalled, lastRunId: input.jobId });
  createJobRepo(input.db).finish({
    jobId: input.jobId,
    state: 'failed',
    outcome: input.reason,
    nowMs: input.nowMs(),
  });

  return { state: stalled.state };
};

const requireRow = (db: Db, fileId: string): MediaFileRow => {
  const row = createMediaFileRepo(db).getById(fileId);
  if (row === null) throw new Error(`Claimed file ${fileId} does not exist.`);
  return row;
};

/**
 * Persist what a run reported: the replacement it made (if any), the ledger
 * transition it implies, and the job row's own outcome.
 *
 * This is the half of the old `runJob` that writes. It takes a `JobReport`,
 * which is plain data — so the run that produced it may have happened in
 * another process — and is the ONLY place the file's next state is decided.
 *
 * Throws when the replacement cannot be recorded (an identity collision, an
 * unreadable replacement). `runJob` folds that into a stall, exactly as it
 * did when this code was inline.
 */
export const applyJobReport = (input: {
  db: Db;
  payload: JobPayload;
  report: JobReport;
  nowMs: () => number;
}): AppliedOutcome => {
  const { db, payload, report } = input;
  const mediaFileRepo = createMediaFileRepo(db);
  const jobRepo = createJobRepo(db);
  const row = requireRow(db, payload.fileId);

  // Whether the LIBRARY FILE actually changed — decided from identity
  // (inode, content hash), never from the replace step's output number and
  // never from whether the job as a whole succeeded. The report carries the
  // raw device/inode/hash the run observed; the row's stored keys are the
  // other half of the comparison, and they live here, in the database, which
  // is why this judgement is made on this side of the seam rather than
  // inside `runPayload`.
  //
  // Unchanged identity means Replace never actually swapped anything in for
  // that invocation — an early refusal (hardlink guard, symlink guard,
  // occupied destination, ...) or the legitimate "already the file this flow
  // produced" no-op, none of which mutate the file object at all, so the
  // reported path still names the untouched original and its identity still
  // matches the row's own pre-run identity.
  const replaced = report.replaced;
  const identity = replaced === null ? null : identityOf(replaced);
  const claimedModified =
    identity !== null &&
    (identity.contentKey !== row.content_key || identity.inodeKey !== row.inode_key);

  let postFacts: FactSet | null = null;

  if (claimedModified && replaced !== null && identity !== null) {
    if (replaced.probe === null || report.postFacts === null) {
      // The file on disk really changed and we cannot describe it: recording
      // the new identity without the probe that goes with it would leave the
      // row claiming pre-transcode codecs for post-transcode content, which
      // is the split state this whole mechanism exists to prevent. Stall
      // instead, with the real reason attached.
      throw new Error(
        `The replacement for "${row.path}" could not be probed: ` +
          `${replaced.probeError ?? 'no probe was produced'}.`,
      );
    }
    postFacts = report.postFacts;

    // Replace Original File just swapped in a file with a NEW inode and NEW
    // content — both identity signals `upsertScanned` matches on move
    // together, at once, on every replacement. Left unrecorded, the next scan
    // computes an identity that matches neither this row's old inode_key nor
    // its old content_key, so it opens a SECOND row for the same path instead
    // of recognising this one: the file (and its now-orphaned first row)
    // never reaches `alreadyGood`, and every scan re-queues and re-transcodes
    // it. Recording the row's row-of-record identity, path, and stat here —
    // by this known fileId, not by a fresh identity search — is what lets the
    // next scan match this exact row again.
    //
    // Done unconditionally on `claimedModified` (identity changed), NOT gated
    // on `report.success` or on the step's output number: the replacement
    // already happened regardless of what a later node in that same flow went
    // on to do or how this node itself routed, and forgetting it here is what
    // made a retry re-discover an already-hevc file as h264 (from the row's
    // stale probe) and burn a second, unnecessary transcode on it.
    //
    // `setProbe` and `updateAfterRun` run inside ONE transaction: a
    // content-key collision in `updateAfterRun` (a restored original that
    // re-encodes byte-identical to a copy already tracked under another row —
    // realistic, not exotic) throws AFTER `setProbe` would otherwise already
    // have committed, which would leave this row with new probe/codec columns
    // but OLD identity/path/size — the exact split state this mechanism
    // exists to prevent, just moved one level down. The transaction makes
    // that impossible: either both writes land, or neither does.
    const probe = replaced.probe;
    const facts = postFacts;
    try {
      db.transaction(() => {
        mediaFileRepo.setProbe({ fileId: row.id, probe, facts });
        mediaFileRepo.updateAfterRun({
          fileId: row.id,
          identity,
          path: replaced.path,
          nlink: replaced.nlink,
          sizeBytes: replaced.sizeBytes,
          mtimeMs: replaced.mtimeMs,
          ctimeMs: replaced.ctimeMs,
          container: replaced.container,
          nowMs: input.nowMs(),
        });
      })();
    } catch (error) {
      if (error instanceof IdentityConflictError) {
        // Explicit, actionable outcome instead of falling into the generic
        // "Unhandled error" stall message: a human needs to resolve the
        // duplicate (delete or requeue one of the two rows) before this file
        // can converge, and retrying on its own will not fix that.
        throw new Error(
          `The replacement for "${row.path}" produced content that already matches ` +
            `another tracked file in this library (${error.message}). Two files in the ` +
            `library now hold byte-identical content — most often a genuine duplicate ` +
            `(the same title present twice) that a deterministic re-encode has made ` +
            `identical, or a second row opened for this same file. Inspect them with ` +
            `"trawlarr status --library <name> --files", then remove whichever copy is ` +
            `redundant and "trawlarr requeue --file <id>" the row you keep.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  const currentSignature = computeSignature({
    flowDefinitionHash: payload.flow.definitionHash,
    facts: postFacts ?? report.preFacts,
  });

  const outcome: RunOutcome = {
    success: report.success,
    claimedModified,
    preFacts: report.preFacts,
    postFacts,
  };
  const ledger: LedgerRecord = mediaFileRepo.getLedger(row.id) ?? newLedgerRecord();
  const nextRecord = applyRunOutcome({
    record: ledger,
    outcome,
    currentSignature,
    nowMs: input.nowMs(),
  });

  mediaFileRepo.setLedger({
    fileId: row.id,
    record: nextRecord,
    preFacts: report.preFacts,
    postFacts,
    lastRunId: payload.jobId,
  });

  jobRepo.finish({
    jobId: payload.jobId,
    state: report.success ? 'succeeded' : 'failed',
    outcome: report.outcome,
    nowMs: input.nowMs(),
  });

  return { state: nextRecord.state };
};

/**
 * Fold an attempt that produced no report at all — a forked worker that
 * crashed, was killed, or was cancelled — into a stalled attempt.
 *
 * `applyStall` is the same backoff `applyRunOutcome` gives a run that
 * finished but did not succeed. The point is that the row always leaves
 * `running`: `claimNext` set it to `running` before the run began, nothing
 * else ever moves it out (the scanner refuses to touch it, `claimNext` only
 * takes `queued`/`held`), and only a manual `requeue` would recover it.
 */
export const applyJobFailure = (input: {
  db: Db;
  payload: JobPayload;
  reason: string;
  nowMs: () => number;
}): AppliedOutcome =>
  stallAttempt({
    db: input.db,
    fileId: input.payload.fileId,
    jobId: input.payload.jobId,
    reason: input.reason,
    nowMs: input.nowMs,
  });

/**
 * The `catch` half of `runJob`: an exception thrown anywhere after the
 * claimed row is known is a failed ATTEMPT on THIS row, not a permanently
 * stuck file.
 *
 * `payload` is null when the failure happened before one could be built (an
 * unknown library, a library with no flow attached, an unknown flow, a file
 * that was never probed) — i.e. before `jobRepo.start` ever ran. A SYNTHETIC
 * job row is recorded for the attempt even then, with sentinel flow columns
 * (`job.flow_id`/`flow_hash` carry no foreign key, so this is safe). Without
 * it, an attempt that failed this early left NO job row at all: an operator
 * saw a `held` file with `attempt_count: 1` and nothing anywhere explaining
 * why, and `RunJobResult.jobId` was the empty string.
 */
export const applyThrownFailure = (input: {
  db: Db;
  row: MediaFileRow;
  payload: JobPayload | null;
  error: unknown;
  nowMs: () => number;
}): { jobId: string; state: FileState; stepCount: number; outcome: string } => {
  const { db, row } = input;
  const jobRepo = createJobRepo(db);
  const message = input.error instanceof Error ? input.error.message : String(input.error);

  // `setLedger` treats `undefined` as "leave `last_run_id` unchanged" and an
  // explicit `null` as "overwrite it with NULL" (see its doc comment) —
  // passing a possibly-null job id here is exactly what erased the pointer to
  // the file's last REAL job. The synthetic-job fallback makes that
  // impossible now.
  const jobId =
    input.payload?.jobId ??
    jobRepo.start({
      fileId: row.id,
      flowId: 'unknown',
      flowHash: 'unknown',
      nowMs: input.nowMs(),
    });

  const outcome = `Unhandled error: ${message}`;
  const { state } = stallAttempt({
    db,
    fileId: row.id,
    jobId,
    reason: outcome,
    nowMs: input.nowMs,
  });

  return { jobId, state, stepCount: jobRepo.getSteps(jobId).length, outcome };
};

/**
 * Fold a job a HUMAN stopped into a requeue rather than a failed attempt.
 *
 * This is the one ending that is not evidence about the file. Every other
 * way a run can end without a report — a plugin that threw, a child that
 * vanished, ffmpeg exiting non-zero — says something about whether this
 * file can converge, so it goes through `applyStall`, which increments
 * `attemptCount` and backs the file off. Cancellation says something about
 * the OPERATOR: they wanted the machine quiet, or the wrong flow was
 * attached, or the box was needed for something else.
 *
 * Counting it as an attempt would be actively harmful, because `applyStall`
 * is not merely cosmetic bookkeeping: attempts accumulate toward the
 * `failed` terminal state, and nothing but a manual `requeue` leaves
 * `failed`. Three interrupted evenings would therefore push a perfectly
 * healthy file into a state a human has to dig it out of. So this uses
 * `mediaFileRepo.requeue` — `applyRequeue`, the same fold a manual requeue
 * performs — which returns the row to `queued` with `attemptCount` and
 * `holdUntilMs` cleared: the file is eligible again the moment a worker is
 * free, exactly as if it had never been claimed.
 *
 * The `job` row still closes, as `cancelled` rather than `failed`. A
 * cancelled attempt DID happen and its steps are worth keeping, but calling
 * it a failure in the one place an operator reads job history would blame
 * the file for something they did.
 *
 * Note what this does NOT need to clean up: the staged output. It lives in
 * the WORKER's temporary work directory, which `runPayload` removes in its
 * own `finally` as the cancelled run unwinds, and the destination
 * reservation is released by the same unwind — neither is reachable from
 * this process, and neither is recorded in the database, so a requeued file
 * has nothing left behind pointing at a half-written encode.
 */
export const applyJobCancelled = (input: {
  db: Db;
  payload: JobPayload;
  nowMs: () => number;
}): AppliedOutcome => {
  const mediaFileRepo = createMediaFileRepo(input.db);
  // Throws for a file that no longer exists, exactly as `requireRow` would:
  // a cancel for a row that has been deleted is a bug worth surfacing, not
  // something to swallow.
  mediaFileRepo.requeue(input.payload.fileId);

  createJobRepo(input.db).finish({
    jobId: input.payload.jobId,
    state: 'cancelled',
    outcome: 'Cancelled: the job was stopped by an operator, so the file was requeued unpenalised.',
    nowMs: input.nowMs(),
  });

  return { state: requireRow(input.db, input.payload.fileId).state };
};
