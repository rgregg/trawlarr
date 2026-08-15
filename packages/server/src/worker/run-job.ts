import { mkdtemp, rm, stat as fsStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  applyRunOutcome,
  applyStall,
  computeSignature,
  extractFacts,
  newLedgerRecord,
  type FactSet,
  type FileState,
  type LedgerRecord,
  type RunOutcome,
} from '@trawlarr/core';
import type { ConfigVars, PluginFileObject, ProbeData } from '@trawlarr/plugin-api';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import {
  buildPluginDeps,
  buildPluginInputArgs,
  createAxiosMiddleware,
  createCrudTransDbn,
  createExecuteRunner,
  createPluginLoader,
  createReplaceOriginalRunner,
  createVerifyOutputRunner,
  runFlow,
  toPluginFileObject,
  type LoadedPlugin,
  type NodeInvocation,
} from '@trawlarr/engine';
import type { Db } from '../db/connection.js';
import { createMediaFileRepo, type ClaimedFile } from '../db/media-file-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createPluginDocumentRepo } from '../db/plugin-document-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { resolveTrashDir } from '../library/paths.js';
import {
  crossDeviceErrorSeam,
  findCompanionsSeam,
  moveCompanionsSeam,
  statFileSeam,
} from '../library/replace-seams.js';
import { probeFile } from '../probe/ffprobe.js';
import { identityFromStat, partialHashFile } from '../fs/partial-hash.js';

export interface RunJobInput {
  db: Db;
  claimed: ClaimedFile;
  ffmpegPath: string;
  ffprobePath: string;
  nowMs: () => number;
}

export interface RunJobResult {
  jobId: string;
  state: FileState;
  stepCount: number;
  outcome: string;
}

/** The engine's own substitute for the Replace Original File node's plugin id. */
const REPLACE_ORIGINAL_PLUGIN_ID = 'trawlarr:replaceOriginal';
/** The engine's own substitute for the Verify Output node's plugin id. */
const VERIFY_OUTPUT_PLUGIN_ID = 'trawlarr:verifyOutput';
/** Output number both safety nodes use for "this did not pass". */
const REJECTION_OUTPUT = 2;

const containerOf = (path: string): string => extname(path).replace('.', '').toLowerCase();

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const staticConfigVars = (input: { ffmpegPath: string }): ConfigVars => ({
  config: {
    nodeID: 'server',
    nodeName: 'server',
    serverURL: '',
    serverIP: '',
    serverPort: '',
    handbrakePath: 'HandBrakeCLI',
    ffmpegPath: input.ffmpegPath,
    mkvpropeditPath: 'mkvpropedit',
    pathTranslators: [],
    platform_arch_isdocker: `${process.platform}_${process.arch}_false`,
    logLevel: 'info',
    processPid: process.pid,
    priority: 0,
    apiKey: '',
    maxLogSizeMB: 10,
    pollInterval: 1000,
    nodeType: 'mapped',
    unmappedNodeCache: '',
    startPaused: false,
  },
});

/**
 * Turn one claimed file into a completed ledger transition: load the
 * library and flow it belongs to, drive it through `runFlow` with the
 * engine's real execute/verify/replace runners wired in, record every step
 * the flow visits, and fold the outcome through `applyRunOutcome`.
 *
 * A flow that never reaches a Replace Original File node is legitimate — a
 * flow that only inspects a file, say. Such a run is judged exactly like any
 * other successful run that made no modification claim: it folds through
 * `applyRunOutcome` with `claimedModified: false`, which resolves to `good`
 * (or leaves whatever state a prior run already settled on) rather than
 * being penalised for skipping a step it was never asked to take. This
 * particular resolution — judge an inspection-only flow the same as any
 * other unmodifying success, rather than inventing a special case for it —
 * was specified by the task coordinator's dispatch, not the brief.
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
  const mediaFileRepo = createMediaFileRepo(db);
  const libraryRepo = createLibraryRepo(db);
  const flowRepo = createFlowRepo(db);
  const jobRepo = createJobRepo(db);

  const row = mediaFileRepo.getById(claimed.fileId);
  if (row === null) throw new Error(`Claimed file ${claimed.fileId} does not exist.`);

  // From here on, the row is real: any failure, however unexpected, is
  // reported as a stalled attempt on THIS row rather than an unhandled
  // rejection that leaves it claimed forever (see the doc comment above).
  let jobId: string | null = null;
  let workDir: string | null = null;
  try {
    const library = libraryRepo.getById(claimed.libraryId);
    if (library === null) {
      throw new Error(`Claimed file's library ${claimed.libraryId} does not exist.`);
    }
    if (library.flowId === null) {
      throw new Error(`Library "${library.name}" has no flow attached; nothing to run.`);
    }
    const flow = flowRepo.getById(library.flowId);
    if (flow === null) {
      throw new Error(`Library "${library.name}" references unknown flow ${library.flowId}.`);
    }

    const preProbe = row.probe_json === null ? null : (JSON.parse(row.probe_json) as ProbeData);
    if (preProbe === null) {
      throw new Error(`File ${row.id} has never been probed; cannot compute a signature for it.`);
    }
    // Extracted directly from the probe/container/size this row holds RIGHT
    // NOW, never via `mediaFileRepo.getProbe` — that method recomputes facts
    // against the row's CURRENT container/size_bytes on every call, which is
    // exactly wrong for "facts as of the moment this run started" once the
    // run itself goes on to touch the row (see its doc comment).
    const preFacts = extractFacts({
      probe: preProbe,
      container: row.container,
      sizeBytes: row.size_bytes,
    });

    jobId = jobRepo.start({
      fileId: row.id,
      flowId: flow.id,
      flowHash: flow.definitionHash,
      nowMs: input.nowMs(),
    });
    // A fresh `running` row is not yet stale, but it should read that way in
    // the database from the start rather than leaving heartbeat_at NULL
    // until the first step completes (or forever, for a flow with none).
    jobRepo.heartbeat({ jobId, nowMs: input.nowMs() });

    workDir = await mkdtemp(join(tmpdir(), 'trawlarr-job-'));

    // Trawlarr's stable identity, not the path (spec 4.2): inode first,
    // falling back to the content-hash key for a file with no stat inode
    // (should not happen for a real file, but the row can technically hold
    // one without the other mid-scan).
    const footprintId = row.inode_key ?? row.content_key;

    const originalFileObject = toPluginFileObject({
      fileId: row.id,
      libraryId: library.id,
      footprintId,
      path: row.path,
      container: row.container,
      sizeBytes: row.size_bytes,
      originalSizeBytes: row.original_size_bytes ?? row.size_bytes,
      mtimeMs: row.mtime_ms,
      ctimeMs: row.ctime_ms,
      probe: preProbe,
      state: row.state,
      lastRunModified: false,
      holdUntilMs: row.hold_until_ms,
      lastTranscodeMs: null,
      lastHealthCheckMs: null,
      history: '',
      discoveredAtMs: row.discovered_at,
    });

    const configVars = staticConfigVars({ ffmpegPath: input.ffmpegPath });
    // The SAME sqlite-backed store every invocation of this job (and every
    // future job for this file) shares, so a plugin's skip-list survives
    // restarts: a fresh in-memory map per job would make `processedCheck`
    // report "not processed" forever.
    const documents = createPluginDocumentRepo(db);
    let pauseAllNodes = false;

    const deps = buildPluginDeps({
      configVars,
      crudTransDBN: createCrudTransDbn({
        documents,
        hostSettings: {
          setPauseAllNodes: (value) => {
            pauseAllNodes = value;
          },
          getPauseAllNodes: () => pauseAllNodes,
        },
        log: () => {},
        nowMs: input.nowMs,
      }),
      axiosMiddleware: createAxiosMiddleware({
        probeFile: (path) => probeFile({ ffprobePath: input.ffprobePath, path }),
        log: () => {},
      }),
    });

    const outputPathFor = (path: string, container: string) => {
      const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
      return join(workDir!, `${stem}.${container || 'mkv'}`);
    };

    const loader = createPluginLoader();

    const runners = [
      createExecuteRunner({ ffmpegPath: input.ffmpegPath, outputPathFor }),
      createVerifyOutputRunner({
        probeFile: (path) => probeFile({ ffprobePath: input.ffprobePath, path }),
        statFile: statFileSeam,
      }),
      createReplaceOriginalRunner({
        trashDirFor: (originalPath) => resolveTrashDir({ library, filePath: originalPath }),
        companionExtensions: library.companionExtensions,
        findCompanions: findCompanionsSeam,
        moveCompanions: moveCompanionsSeam,
        allowHardlinked: library.allowHardlinked,
        statFile: statFileSeam,
        crossDeviceError: crossDeviceErrorSeam,
        nowMs: input.nowMs,
      }),
    ];

    const loadPlugin = (node: { pluginId: string }): LoadedPlugin => {
      const firstParty = FIRST_PARTY_PLUGINS[node.pluginId];
      if (firstParty !== undefined) {
        const base: LoadedPlugin = {
          id: firstParty.id,
          absPath: `builtin:${firstParty.id}`,
          version: '1.0.0',
          details: firstParty.module.details(),
          module: firstParty.module,
        };
        const substitute = runners.reduce<ReturnType<(typeof runners)[number]>>(
          (found, runner) => found ?? runner(base),
          null,
        );
        return substitute === null ? base : { ...base, module: substitute };
      }
      return loader.load(node.pluginId);
    };

    // Carries a node's mutations to the file object (container, file_size,
    // newSize/oldSize, codec names — everything Replace Original File's
    // `describeReplacement` writes onto it) forward into the NEXT node's
    // input. Reset only `_id`/`file` per invocation, from `originalFileObject`,
    // would make a node placed after Execute or Replace read PRE-run values
    // for everything else — the same convention the engine CLI uses today,
    // but one the server is the first place to actually run flows where it
    // would silently feed a downstream codec/size check stale data.
    let lastFileObject: PluginFileObject = originalFileObject;
    // The file object actually passed to the LAST node invocation whose
    // pluginId was Replace Original File, captured so the post-run re-probe
    // targets exactly what THAT node produced — never `result.currentPath`,
    // which is whatever the flow's FINAL node happened to leave behind. A
    // flow that loops back to Execute after replacing (another transcode,
    // a health check, anything) ends with `currentPath` pointing at a
    // scratch file inside `workDir`, which the `finally` below deletes
    // seconds later; re-probing THAT and storing its facts as the file's
    // signature would describe a file that no longer exists.
    //
    // Held in an object property (not a bare `let`) so the assignment inside
    // the `buildArgs` closure below is visible without TypeScript narrowing
    // the outer binding back to its initial `null` at the point it is read,
    // long after `runFlow` has actually invoked that closure.
    const replaceInvocation: { fileObject: PluginFileObject | null } = { fileObject: null };

    const buildArgs = (invocation: NodeInvocation) => {
      const args = buildPluginInputArgs({
        fileObject: {
          ...lastFileObject,
          _id: invocation.currentPath,
          file: invocation.currentPath,
        },
        originalFileObject,
        nodeInputs: invocation.node.inputs,
        variables: invocation.variables,
        // The LibraryRecord itself: community plugins read librarySettings
        // (30 hits in the corpus).
        librarySettings: library as unknown as Record<string, unknown>,
        userVariables: { global: {}, library: library.userVariables },
        configVars,
        deps,
        workDir: workDir!,
        jobId: jobId!,
        footprintId,
        fileId: row.id,
        jobStartMs: input.nowMs(),
        workerClass: 'transcode',
        hardwareType: 'cpu',
        log: () => {},
      });
      lastFileObject = args.inputFileObj;
      if (invocation.node.pluginId === REPLACE_ORIGINAL_PLUGIN_ID) {
        replaceInvocation.fileObject = args.inputFileObj;
      }
      return args;
    };

    const result = await runFlow({
      flow: flow.definition,
      initialPath: row.path,
      loadPlugin,
      buildArgs,
      nowMs: input.nowMs,
      onStep: (step) => {
        jobRepo.recordStep({
          jobId: jobId!,
          step: {
            seq: step.seq,
            nodeId: step.nodeId,
            pluginId: step.pluginId,
            outputNumber: step.outputNumber,
            durationMs: step.durationMs,
            logExcerpt: step.logExcerpt,
            error: step.error,
          },
        });
        // Once per completed step: the natural unit of progress here, since
        // every long-running node (Execute, Verify, Replace) is itself one
        // step. A worker that dies mid-step leaves `heartbeat_at` at its
        // last COMPLETED step, which is exactly what a stall reaper compares
        // against — never advancing was the actual defect, not the exact
        // granularity.
        jobRepo.heartbeat({ jobId: jobId!, nowMs: input.nowMs() });
      },
    });

    // `runFlow` reports `end-of-flow` whenever the current node's output has
    // no outgoing edge — which is exactly what happens when Verify Output
    // rejects (output 2) or Replace Original File refuses (output 2) and the
    // flow's author never wired a remediation path from there. That is not
    // success: it is the safety net catching a bad encode or a refused
    // replacement, and a flow that ends there converged on nothing. Only the
    // LAST step matters — `end-of-flow` fires for whichever node's output
    // had no edge, which is always the final entry in `result.steps` — so a
    // flow that DOES route rejection somewhere (quarantine, alert, retry) and
    // finishes on its own terms downstream is unaffected.
    const lastStep = result.steps.at(-1);
    const rejectedWithNoRemediation =
      lastStep !== undefined &&
      (lastStep.pluginId === VERIFY_OUTPUT_PLUGIN_ID ||
        lastStep.pluginId === REPLACE_ORIGINAL_PLUGIN_ID) &&
      lastStep.outputNumber === REJECTION_OUTPUT;

    const success = !result.failed && !rejectedWithNoRemediation;

    // The flow's own claim of having modified the library file: it reached
    // the Replace Original File node and that node routed to its success
    // output. Tied to Replace rather than Execute, because Execute only
    // ever writes into workDir — Replace is the one node that touches the
    // library, so it is the only place a claim about the LIBRARY FILE can
    // legitimately come from. Computed over EVERY step, not just the last,
    // and deliberately independent of `success`: a node placed after a
    // successful Replace can still fail the overall run, but the
    // replacement itself already happened and must not be forgotten.
    const claimedModified = result.steps.some(
      (step) => step.pluginId === REPLACE_ORIGINAL_PLUGIN_ID && step.outputNumber === 1,
    );

    let postFacts: FactSet | null = null;
    if (claimedModified) {
      // The path Replace Original File itself produced — see
      // `replaceInvocation`'s doc comment above for why this is not
      // `result.currentPath`.
      const replacedPath = replaceInvocation.fileObject?._id ?? result.currentPath;

      const newProbe = await probeFile({ ffprobePath: input.ffprobePath, path: replacedPath });
      const newStats = await fsStat(replacedPath);
      // Extracted from the probe and stat this run just took, alongside the
      // container/size it actually means — never from `getProbe`, whose
      // "facts as of now" recompute against the row's container/size_bytes
      // columns, which `setProbe` below does NOT update.
      postFacts = extractFacts({
        probe: newProbe,
        container: containerOf(replacedPath),
        sizeBytes: newStats.size,
      });
      mediaFileRepo.setProbe({ fileId: row.id, probe: newProbe, facts: postFacts });

      // Replace Original File just swapped in a file with a NEW inode and
      // NEW content — both identity signals `upsertScanned` matches on move
      // together, at once, on every replacement. Left unrecorded, the next
      // scan computes an identity that matches neither this row's old
      // inode_key nor its old content_key, so it opens a SECOND row for the
      // same path instead of recognising this one: the file (and its
      // now-orphaned first row) never reaches `alreadyGood`, and every scan
      // re-queues and re-transcodes it. Recording the row's row-of-record
      // identity, path, and stat here — by this known fileId, not by a
      // fresh identity search — is what lets the next scan match this exact
      // row again.
      //
      // Done unconditionally on `claimedModified`, NOT gated on `success`:
      // the replacement already happened regardless of what a later node in
      // this same flow goes on to do, and forgetting it here is what made a
      // retry re-discover an already-hevc file as h264 (from the row's stale
      // probe) and burn a second, unnecessary transcode on it.
      const newHash = await partialHashFile(replacedPath);
      const identity = identityFromStat({ stat: newStats, hash: newHash });
      mediaFileRepo.updateAfterRun({
        fileId: row.id,
        identity,
        path: replacedPath,
        nlink: newStats.nlink,
        sizeBytes: newStats.size,
        mtimeMs: newStats.mtimeMs,
        ctimeMs: newStats.ctimeMs,
        container: containerOf(replacedPath),
        nowMs: input.nowMs(),
      });
    }

    const currentFacts = postFacts ?? preFacts;
    const currentSignature = computeSignature({
      flowDefinitionHash: flow.definitionHash,
      facts: currentFacts,
    });

    const outcome: RunOutcome = { success, claimedModified, preFacts, postFacts };
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
      preFacts,
      postFacts,
      lastRunId: jobId,
    });

    const outcomeText = success
      ? `Flow finished: ${result.stopReason}.`
      : rejectedWithNoRemediation
        ? `Flow finished, but "${lastStep?.pluginName ?? lastStep?.pluginId}" rejected on output ` +
          `${REJECTION_OUTPUT} with no route from there.`
        : `Flow failed: ${result.error ?? result.stopReason}`;

    jobRepo.finish({
      jobId,
      state: success ? 'succeeded' : 'failed',
      outcome: outcomeText,
      nowMs: input.nowMs(),
    });

    return {
      jobId,
      state: nextRecord.state,
      stepCount: result.steps.length,
      outcome: outcomeText,
    };
  } catch (error) {
    // Anything unexpected — a missing library/flow, an unprobed file,
    // ffmpeg/ffprobe throwing outright, a filesystem error creating workDir
    // — is a failed ATTEMPT, not a permanently stuck file: `applyStall` is
    // the same backoff `applyRunOutcome` already gives a run that finished
    // but did not succeed. Without this, `claimNext` set the row to
    // `running` before `runJob` was ever called, nothing else ever moves it
    // out of `running` (the scanner refuses to touch it, `claimNext` only
    // takes `queued`/`held`), and only a manual `requeue` recovers it.
    const message = messageOf(error);
    const ledger = mediaFileRepo.getLedger(row.id) ?? newLedgerRecord();
    const stalled = applyStall({ record: ledger, nowMs: input.nowMs() });
    mediaFileRepo.setLedger({ fileId: row.id, record: stalled, lastRunId: jobId });
    if (jobId !== null) {
      jobRepo.finish({
        jobId,
        state: 'failed',
        outcome: `Unhandled error: ${message}`,
        nowMs: input.nowMs(),
      });
    }
    return {
      jobId: jobId ?? '',
      state: stalled.state,
      stepCount: jobId === null ? 0 : jobRepo.getSteps(jobId).length,
      outcome: `Unhandled error: ${message}`,
    };
  } finally {
    if (workDir !== null) await rm(workDir, { recursive: true, force: true });
  }
};
