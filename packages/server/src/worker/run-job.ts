import type { FileState } from '@trawlarr/core';
import type { MoveCompanionsFn, StatFileFn } from '@trawlarr/engine';
import type { Db } from '../db/connection.js';
import { createMediaFileRepo, type ClaimedFile } from '../db/media-file-repo.js';
import { createPluginDocumentRepo } from '../db/plugin-document-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { buildJobPayload, type JobPayload } from './job-payload.js';
import { runPayload } from './run-payload.js';
import { applyJobReport, applyThrownFailure } from './apply-report.js';

export interface RunJobInput {
  db: Db;
  claimed: ClaimedFile;
  ffmpegPath: string;
  ffprobePath: string;
  nowMs: () => number;
  /**
   * Seams for tests: substitute Replace Original File's companion mover and
   * stat function. Default to the real implementations
   * (`moveCompanionsSeam`/`statFileSeam`) — production code never sets
   * these. They exist because two of `replaceOriginal`'s real branches (a
   * swap that lands but leaves the file hardlinked; a swap that lands but
   * whose companion move fails partway) are reachable only by injecting a
   * failure here: real-filesystem privilege that would force them
   * (`chattr +i`, a genuine EACCES/EXDEV on a same-directory rename) is not
   * available in an unprivileged single-process test, and both branches
   * still need to be provably exercised — see `run-job.test.ts`'s I-4 test.
   */
  moveCompanions?: MoveCompanionsFn;
  statFile?: StatFileFn;
}

export interface RunJobResult {
  jobId: string;
  state: FileState;
  stepCount: number;
  outcome: string;
}

/**
 * The job id a payload carries before its `job` row exists.
 *
 * The `job` row records which flow and flow hash the attempt ran under, so
 * the flow has to be read before the row can be inserted — and reading the
 * flow is `buildJobPayload`'s job. The payload is therefore built first and
 * given its id a moment later. That ordering is not incidental: it is
 * exactly the pre-split ordering, in which a missing library, an unattached
 * flow, an unknown flow or an unprobed file throws BEFORE any job row
 * exists — the case `applyThrownFailure`'s synthetic job row covers.
 */
const UNSTARTED_JOB_ID = '';

/**
 * Turn one claimed file into a completed ledger transition, in this process.
 *
 * Since P2b Task 4 this is a COMPOSITION of three pieces, and all of the
 * behaviour lives in them:
 *
 *  - `buildJobPayload` reads the database and produces the run's whole input
 *    as plain data;
 *  - `runPayload` runs the flow and touches no database at all, which is what
 *    lets a worker run it in a forked child process;
 *  - `applyJobReport` writes the outcome back.
 *
 * A flow that never reaches a Replace Original File node is legitimate — a
 * flow that only inspects a file, say. Such a run is judged exactly like any
 * other successful run that made no modification claim: it folds through
 * `applyRunOutcome` with `claimedModified: false`, which resolves to `good`
 * (or leaves whatever state a prior run already settled on) rather than
 * being penalised for skipping a step it was never asked to take.
 *
 * Any exception raised after the claimed row is known — a missing
 * library/flow, an unreadable probe, ffmpeg/ffprobe failing outright, a
 * filesystem error — is caught and treated as a STALL (`applyStall`, the
 * same "failed attempt" backoff `applyRunOutcome` gives a run that finished
 * but did not succeed), so the row always leaves `running` rather than
 * being stuck there until a manual `requeue`.
 */
export const runJob = async (input: RunJobInput): Promise<RunJobResult> => {
  const { db, claimed } = input;
  const jobRepo = createJobRepo(db);

  const row = createMediaFileRepo(db).getById(claimed.fileId);
  if (row === null) throw new Error(`Claimed file ${claimed.fileId} does not exist.`);

  // From here on, the row is real: any failure, however unexpected, is
  // reported as a stalled attempt on THIS row rather than an unhandled
  // rejection that leaves it claimed forever (see the doc comment above).
  let payload: JobPayload | null = null;
  try {
    const draft = buildJobPayload({
      db,
      claimed,
      jobId: UNSTARTED_JOB_ID,
      // In-process runs are transcode work on the CPU. Task 7 gives the
      // daemon real worker classes and declared hardware to pass down here.
      workerClass: 'transcode',
      hardwareType: 'cpu',
      ffmpegPath: input.ffmpegPath,
      ffprobePath: input.ffprobePath,
    });

    const jobId = jobRepo.start({
      fileId: draft.fileId,
      flowId: draft.flow.id,
      flowHash: draft.flow.definitionHash,
      nowMs: input.nowMs(),
      workerClass: draft.workerClass,
    });
    payload = { ...draft, jobId };

    const report = await runPayload({
      payload,
      ports: {
        // The SAME sqlite-backed store every invocation of this job (and
        // every future job for this file) shares, so a plugin's skip-list
        // survives restarts: a fresh in-memory map per job would make
        // `processedCheck` report "not processed" forever.
        documents: createPluginDocumentRepo(db),
        onStep: (step) =>
          jobRepo.recordStep({
            jobId,
            step: {
              seq: step.seq,
              nodeId: step.nodeId,
              pluginId: step.pluginId,
              outputNumber: step.outputNumber,
              durationMs: step.durationMs,
              logExcerpt: step.logExcerpt,
              error: step.error,
            },
          }),
        onHeartbeat: (nowMs) => jobRepo.heartbeat({ jobId, nowMs }),
        onProgress: () => {},
        onLog: () => {},
        nowMs: input.nowMs,
        moveCompanions: input.moveCompanions,
        statFile: input.statFile,
      },
    });

    const { state } = applyJobReport({ db, payload, report, nowMs: input.nowMs });
    return { jobId, state, stepCount: report.steps.length, outcome: report.outcome };
  } catch (error) {
    return applyThrownFailure({ db, row, payload, error, nowMs: input.nowMs });
  }
};
