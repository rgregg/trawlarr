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
import type {
  ConfigVars,
  PluginFileObject,
  PluginInputArgs,
  ProbeData,
} from '@trawlarr/plugin-api';
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
  type MoveCompanionsFn,
  type NodeInvocation,
  type StatFileFn,
} from '@trawlarr/engine';
import type { Db } from '../db/connection.js';
import {
  createMediaFileRepo,
  IdentityConflictError,
  type ClaimedFile,
} from '../db/media-file-repo.js';
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

/** The engine's own substitute for the Replace Original File node's plugin id. */
const REPLACE_ORIGINAL_PLUGIN_ID = 'trawlarr:replaceOriginal';

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

    // The args object `buildArgs` most recently produced — i.e. the one
    // belonging to the step currently executing. `runFlow` REASSIGNS
    // `args.jobLog` on that same object after `buildArgs` returns, wrapping
    // it so everything written lands in that step's `logExcerpt`; going
    // through this reference (rather than capturing the function) is what
    // makes a runner's own log output reach the wrapper, and therefore the
    // `job_step.log_excerpt` column.
    let currentArgs: PluginInputArgs | null = null;

    const runners = [
      createExecuteRunner({
        ffmpegPath: input.ffmpegPath,
        outputPathFor,
        // Without this, `execute-node.ts`'s `ffmpeg failed (code N):
        // <stderrTail>` — the ONLY record of why an encode failed — went
        // nowhere, and the Execute step's log excerpt was empty: an
        // operator saw a held file with no reason attached anywhere in the
        // database.
        log: (text) => currentArgs?.jobLog(text),
      }),
      createVerifyOutputRunner({
        probeFile: (path) => probeFile({ ffprobePath: input.ffprobePath, path }),
        statFile: statFileSeam,
      }),
      createReplaceOriginalRunner({
        trashDirFor: (originalPath) => resolveTrashDir({ library, filePath: originalPath }),
        companionExtensions: library.companionExtensions,
        findCompanions: findCompanionsSeam,
        moveCompanions: input.moveCompanions ?? moveCompanionsSeam,
        allowHardlinked: library.allowHardlinked,
        statFile: input.statFile ?? statFileSeam,
        crossDeviceError: crossDeviceErrorSeam,
        nowMs: input.nowMs,
      }),
    ];

    // The `outputFileObj` Replace Original File itself RETURNED, from EVERY
    // invocation in this run, oldest first — captured by wrapping its
    // substituted `plugin()` function, not by reading what was fed IN to
    // the node. This is the fix for I-4: the node's own return value is
    // authoritative for "what path now holds the library file", on EVERY
    // output number, because `replaceOriginal` sets `outputFileObj._id` to
    // the real swapped-in path on the two branches where a swap lands but
    // the node still reports failure (left hardlinked; a companion move
    // that split) — reading the INPUT object instead would miss those, and
    // reading only `outputNumber === 1` (an earlier version of this fix)
    // missed them too. `runFlow` itself updates its OWN `currentPath` from
    // this same value after every step regardless of output number, so
    // this mirrors exactly what the engine already treats as authoritative
    // — captured here only because `result.currentPath` alone conflates
    // every node, not just Replace (see the loop-back comment below).
    //
    // Recording EVERY invocation, not just the last, is the fix for I-5: a
    // flow with two Replace nodes where the first changes the container
    // (`sample.mkv` -> `sample.mp4`) and a LATER one refuses reports the
    // pre-run `originalPath` (`sample.mkv`) in ITS OWN `outputFileObj` —
    // correctly, as far as that node's own contract goes, but that path no
    // longer exists on disk. Below, the most RECENT invocation whose
    // reported path can still be stat'd wins, so a stale later report can
    // never erase the record of an earlier, real swap. The guard on
    // `outputFileObj?._id` being a string is defensive: only the
    // substituted first-party runner is ever wrapped below, so it always
    // returns a well-formed `outputFileObj`, but nothing should silently
    // misread a malformed one as "no replacement happened" without at
    // least being written to make that reasoning explicit.
    const replaceOutputs: { _id: string }[] = [];

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
        if (substitute === null) return base;
        if (node.pluginId !== REPLACE_ORIGINAL_PLUGIN_ID) return { ...base, module: substitute };
        return {
          ...base,
          module: {
            details: substitute.details,
            plugin: async (args) => {
              const output = await substitute.plugin(args);
              if (typeof output.outputFileObj?._id === 'string') {
                replaceOutputs.push(output.outputFileObj);
              }
              return output;
            },
          },
        };
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
      currentArgs = args;
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

    // THE RULE: a terminal output the flow author did not route, on a node
    // that is reporting failure, is not success.
    //
    // Both halves are read from things that already exist and generalise:
    //
    //  - "terminal and unrouted" is `stopReason === 'end-of-flow'`, which
    //    `runFlow` returns from exactly one place — the branch where no edge
    //    leaves the output the node just took. The flow definition knows
    //    which outputs have no outgoing edge; this is that fact, already
    //    computed. Only the LAST step can be the unrouted one, so that is
    //    the step judged. A flow that DOES route its failure output
    //    somewhere (quarantine, alert, retry with different settings) and
    //    finishes on its own terms downstream is unaffected.
    //
    //  - "reporting failure" is the node's OWN `details()` declaration for
    //    the output it took (`PluginOutputDescriptor.outcome`), captured on
    //    the step by `runFlow`. Not a plugin-id allow-list: that shape
    //    listed Verify Output and Replace Original File and silently
    //    omitted Execute, so ffmpeg exiting non-zero — a missing hardware
    //    encoder, a corrupt source, ENOSPC in staging — ended the flow with
    //    `success = true` and stored the PRE-transcode signature as `good`,
    //    which `isKnownGood` then matched forever: a whole library
    //    reporting "100% converged" with nothing transcoded and no error
    //    anywhere. An id list has to be extended for every future
    //    first-party node and can never cover a community plugin at all;
    //    a declaration travels with the node that owns the meaning.
    //
    // A node that declares nothing (the Tdarr-compatible shape) is neutral,
    // which is deliberate and conservative in the safe direction: guessing
    // "failure" from an undeclared output — say, by pattern-matching the
    // tooltip — would misread a filter node's "no, this file is not hevc"
    // as a failure and hold files that had genuinely converged.
    const lastStep = result.steps.at(-1);
    const endedOnUnroutedFailure =
      result.stopReason === 'end-of-flow' &&
      lastStep !== undefined &&
      lastStep.outputOutcome === 'failure';

    const success = !result.failed && !endedOnUnroutedFailure;

    // Whether the LIBRARY FILE actually changed — decided from identity
    // (inode, content hash), never from the replace step's output number.
    // The output number says whether the JOB considers itself successful; it
    // does not say whether the FILESYSTEM changed, and those are different
    // questions. `replaceOriginal` can swap the file in and still route to
    // its failure output — landed-but-left-hardlinked
    // (`packages/engine/src/executor/replace-original.ts` around the
    // `leftLinked` check) and landed-but-companions-split are both real,
    // reachable branches where `describeReplacement` already ran (setting
    // `outputFileObj._id` to the new path) before the node returned output
    // 2. Requiring output 1 missed exactly those two branches: the row's
    // probe/identity were never updated even though the file on disk
    // already had a new inode and new content — the same orphaned-row bug
    // this whole mechanism exists to eliminate, still live in the branches
    // the earlier, output-number-based check did not reach.
    //
    // Tried most-recent-invocation first, falling back to earlier ones: a
    // container-changing Replace followed by a LATER Replace that refuses
    // reports that later node's own `originalPath` — correct for that
    // node's own contract, but a path an earlier, successful swap in THIS
    // SAME run may have already renamed away, so `fsStat`/hashing it
    // throws ENOENT. That must never propagate into the stall path below:
    // the read that DETECTS a change must never be able to DESTROY the
    // record of a change that already happened. Falling back to the
    // invocation before it is what lets a real, still-on-disk swap still
    // be found and recorded even when the LAST report about it is stale.
    let replacedPath: string | null = null;
    let newStats: Awaited<ReturnType<typeof fsStat>> | null = null;
    let newIdentity: ReturnType<typeof identityFromStat> | null = null;
    for (let i = replaceOutputs.length - 1; i >= 0; i -= 1) {
      const candidate = replaceOutputs[i]!._id;
      try {
        const stats = await fsStat(candidate);
        const hash = await partialHashFile(candidate);
        replacedPath = candidate;
        newStats = stats;
        newIdentity = identityFromStat({ stat: stats, hash });
        break;
      } catch {
        // This invocation's reported path is gone — try the one before it.
      }
    }

    let postFacts: FactSet | null = null;
    let claimedModified = false;
    if (replacedPath !== null && newStats !== null && newIdentity !== null) {
      // Bind to plain consts: read inside the `db.transaction` closure
      // below, where TypeScript would otherwise narrow these outer `let`
      // bindings back to their declared (possibly-null) type instead of
      // the values just assigned (the same reasoning applies as it did for
      // `replaceOutputs` above).
      const path = replacedPath;
      const stats = newStats;
      const identity = newIdentity;
      // Unchanged identity means Replace never actually swapped anything in
      // for THIS invocation — an early refusal (hardlink guard, symlink
      // guard, occupied destination, ...) or the legitimate "already the
      // file this flow produced" no-op, none of which mutate the file
      // object at all, so `replacedPath` still names the untouched original
      // and its identity still matches the row's own pre-run identity.
      claimedModified =
        identity.contentKey !== row.content_key || identity.inodeKey !== row.inode_key;

      if (claimedModified) {
        const newProbe = await probeFile({ ffprobePath: input.ffprobePath, path });
        // Extracted from the probe and stat this run just took, alongside
        // the container/size it actually means — never from `getProbe`,
        // whose "facts as of now" recompute against the row's
        // container/size_bytes columns, which `setProbe` below does NOT
        // update.
        postFacts = extractFacts({
          probe: newProbe,
          container: containerOf(path),
          sizeBytes: stats.size,
        });

        // Replace Original File just swapped in a file with a NEW inode and
        // NEW content — both identity signals `upsertScanned` matches on
        // move together, at once, on every replacement. Left unrecorded,
        // the next scan computes an identity that matches neither this
        // row's old inode_key nor its old content_key, so it opens a SECOND
        // row for the same path instead of recognising this one: the file
        // (and its now-orphaned first row) never reaches `alreadyGood`, and
        // every scan re-queues and re-transcodes it. Recording the row's
        // row-of-record identity, path, and stat here — by this known
        // fileId, not by a fresh identity search — is what lets the next
        // scan match this exact row again.
        //
        // Done unconditionally on `claimedModified` (identity changed), NOT
        // gated on `success` or on the step's output number: the
        // replacement already happened regardless of what a later node in
        // this same flow goes on to do or how this node itself routed, and
        // forgetting it here is what made a retry re-discover an
        // already-hevc file as h264 (from the row's stale probe) and burn a
        // second, unnecessary transcode on it.
        //
        // `setProbe` and `updateAfterRun` run inside ONE transaction: a
        // content-key collision in `updateAfterRun` (a restored original
        // that re-encodes byte-identical to a copy already tracked under
        // another row — realistic, not exotic) throws AFTER `setProbe`
        // would otherwise already have committed, which would leave this
        // row with new probe/codec columns but OLD identity/path/size — the
        // exact split state this mechanism exists to prevent, just moved
        // one level down. The transaction makes that impossible: either
        // both writes land, or neither does.
        // A plain const, not the outer `let postFacts`: read inside the
        // `db.transaction` closure below, where TypeScript would otherwise
        // narrow the outer binding back to its declared union type instead
        // of the value just assigned (the same reasoning as `path`/`stats`/
        // `identity` above, for the same closure-narrowing reason).
        const factsForThisReplacement = postFacts;
        try {
          db.transaction(() => {
            mediaFileRepo.setProbe({
              fileId: row.id,
              probe: newProbe,
              facts: factsForThisReplacement,
            });
            mediaFileRepo.updateAfterRun({
              fileId: row.id,
              identity,
              path,
              nlink: stats.nlink,
              sizeBytes: stats.size,
              mtimeMs: stats.mtimeMs,
              ctimeMs: stats.ctimeMs,
              container: containerOf(path),
              nowMs: input.nowMs(),
            });
          })();
        } catch (error) {
          if (error instanceof IdentityConflictError) {
            // Explicit, actionable outcome instead of falling into the
            // generic "Unhandled error" stall message below: a human needs
            // to resolve the duplicate (delete or requeue one of the two
            // rows) before this file can converge, and retrying on its own
            // will not fix that.
            throw new Error(
              `The replacement for "${row.path}" produced content that already matches ` +
                `another tracked file in this library (${error.message}). This can happen ` +
                `when a previous original is restored from ".trawlarr/trash" beside its own ` +
                `already-transcoded copy and a deterministic re-encode reproduces it ` +
                `byte-for-byte. Resolve the duplicate manually (delete or requeue one of the ` +
                `two rows) before this file can converge.`,
              { cause: error },
            );
          }
          throw error;
        }
      }
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
      : endedOnUnroutedFailure
        ? `Flow finished, but "${lastStep?.pluginName ?? lastStep?.pluginId}" reported failure ` +
          `on output ${String(lastStep?.outputNumber)}, which this flow routes nowhere.`
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

    // A failure can happen before `jobRepo.start` ever ran (an unknown
    // library, a library with no flow attached, an unknown flow, a file
    // that was never probed) — record a SYNTHETIC job row for the attempt
    // even then, with sentinel flow columns (job.flow_id/flow_hash carry no
    // foreign key, so this is safe). Without this, an attempt that failed
    // this early left NO job row at all: an operator saw a `held` file with
    // `attempt_count: 1` and nothing anywhere explaining why, and
    // `RunJobResult.jobId` was the empty string.
    const finalJobId =
      jobId ??
      jobRepo.start({
        fileId: row.id,
        flowId: 'unknown',
        flowHash: 'unknown',
        nowMs: input.nowMs(),
      });

    // `setLedger` treats `undefined` as "leave `last_run_id` unchanged" and
    // an explicit `null` as "overwrite it with NULL" (see its doc comment)
    // — passing the bare `jobId` local here, before it could be `null`, is
    // exactly what erased the pointer to the file's last REAL job. Passing
    // `finalJobId` (guaranteed a real string by the synthetic-job fallback
    // above) makes that impossible now.
    mediaFileRepo.setLedger({ fileId: row.id, record: stalled, lastRunId: finalJobId });
    jobRepo.finish({
      jobId: finalJobId,
      state: 'failed',
      outcome: `Unhandled error: ${message}`,
      nowMs: input.nowMs(),
    });
    return {
      jobId: finalJobId,
      state: stalled.state,
      stepCount: jobRepo.getSteps(finalJobId).length,
      outcome: `Unhandled error: ${message}`,
    };
  } finally {
    if (workDir !== null) await rm(workDir, { recursive: true, force: true });
  }
};
