import { mkdtemp, rm, stat as fsStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  applyRunOutcome,
  computeSignature,
  extractFacts,
  newLedgerRecord,
  type FactSet,
  type FileState,
  type LedgerRecord,
  type RunOutcome,
} from '@trawlarr/core';
import type { ConfigVars, ProbeData } from '@trawlarr/plugin-api';
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

const containerOf = (path: string): string => extname(path).replace('.', '').toLowerCase();

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
 * being penalised for skipping a step it was never asked to take.
 */
export const runJob = async (input: RunJobInput): Promise<RunJobResult> => {
  const { db, claimed } = input;
  const mediaFileRepo = createMediaFileRepo(db);
  const libraryRepo = createLibraryRepo(db);
  const flowRepo = createFlowRepo(db);
  const jobRepo = createJobRepo(db);

  const row = mediaFileRepo.getById(claimed.fileId);
  if (row === null) throw new Error(`Claimed file ${claimed.fileId} does not exist.`);

  const library = libraryRepo.getById(claimed.libraryId);
  if (library === null)
    throw new Error(`Claimed file's library ${claimed.libraryId} does not exist.`);
  if (library.flowId === null) {
    throw new Error(`Library "${library.name}" has no flow attached; nothing to run.`);
  }
  const flow = flowRepo.getById(library.flowId);
  if (flow === null)
    throw new Error(`Library "${library.name}" references unknown flow ${library.flowId}.`);

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

  const jobId = jobRepo.start({
    fileId: row.id,
    flowId: flow.id,
    flowHash: flow.definitionHash,
    nowMs: input.nowMs(),
  });

  const workDir = await mkdtemp(join(tmpdir(), 'trawlarr-job-'));
  try {
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
    const documents = createPluginDocumentRepo(db);
    let pauseAllNodes = false;

    const deps = buildPluginDeps({
      configVars,
      crudTransDBN: createCrudTransDbn({
        // The plugin document store, so a plugin's skip-list survives
        // restarts: a fresh in-memory map per job would make
        // `processedCheck` report "not processed" forever.
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
      return join(workDir, `${stem}.${container || 'mkv'}`);
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

    const buildArgs = (invocation: NodeInvocation) =>
      buildPluginInputArgs({
        fileObject: {
          ...originalFileObject,
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
        workDir,
        jobId,
        footprintId,
        fileId: row.id,
        jobStartMs: input.nowMs(),
        workerClass: 'transcode',
        hardwareType: 'cpu',
        log: () => {},
      });

    const result = await runFlow({
      flow: flow.definition,
      initialPath: row.path,
      loadPlugin,
      buildArgs,
      nowMs: input.nowMs,
      onStep: (step) => {
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
        });
      },
    });

    const success = !result.failed;

    // The flow's own claim of having modified the library file: it reached
    // the Replace Original File node and that node routed to its success
    // output. Tied to Replace rather than Execute, because Execute only
    // ever writes into workDir — Replace is the one node that touches the
    // library, so it is the only place a claim about the LIBRARY FILE can
    // legitimately come from. A flow that never reaches it (inspection-only,
    // or one that stops earlier because the file already satisfies it)
    // makes no such claim, and is judged as an ordinary successful run.
    const claimedModified = result.steps.some(
      (step) => step.pluginId === REPLACE_ORIGINAL_PLUGIN_ID && step.outputNumber === 1,
    );

    let postFacts: FactSet | null = null;
    if (success && claimedModified) {
      const newProbe = await probeFile({
        ffprobePath: input.ffprobePath,
        path: result.currentPath,
      });
      const newStats = await fsStat(result.currentPath);
      // Extracted from the probe and stat this run just took, alongside the
      // container/size it actually means — never from `getProbe`, whose
      // "facts as of now" recompute against the row's container/size_bytes
      // columns, which `setProbe` below does NOT update.
      postFacts = extractFacts({
        probe: newProbe,
        container: containerOf(result.currentPath),
        sizeBytes: newStats.size,
      });
      mediaFileRepo.setProbe({ fileId: row.id, probe: newProbe, facts: postFacts });
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
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};
