import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import { FlowAbort, type DocumentPort, type StepRecord } from '@trawlarr/engine';
import type { JobPayload } from './job-payload.js';
import {
  runPayload,
  SupersededError,
  type CommitGate,
  type RunPayloadPorts,
} from './run-payload.js';
import { resolveStagingDir } from '../library/paths.js';
import { workDirPrefix } from '../library/staging-dir.js';
import { probeFile } from '../probe/ffprobe.js';
import { corpusAvailable, pluginPath } from '../../../engine/test/compat/corpus.js';
import { toolAvailableSync } from '../../../../test-support/tool-availability.js';

// NOTE: nothing in this file opens, imports or constructs a database. That is
// the property under test, not an accident of the fixtures — see the
// "no database" describe block at the bottom, which pins it structurally.

const NOW = 1_700_000_000_000;

const HEVC_PROBE: ProbeData = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 320, height: 240 },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '2.0', size: '4096', bit_rate: '16384' },
};

const TWO_NODE_FLOW: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'check',
      pluginId: 'trawlarr:checkVideoCodec',
      pluginVersion: '1.0.0',
      inputs: { codec: 'hevc' },
    },
  ],
  // `check`'s "already this codec" output (1) is deliberately routed
  // nowhere: that is the ordinary end of a converged run.
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' }],
};

/** A payload built by hand — no database, no repositories, no rows. */
const payloadFor = (flow: FlowDefinition): JobPayload => ({
  jobId: 'job-1',
  fileId: 'file-1',
  libraryId: 'lib-1',
  path: '/lib/movie.mkv',
  container: 'mkv',
  sizeBytes: 4096,
  originalSizeBytes: 4096,
  mtimeMs: NOW - 1000,
  ctimeMs: NOW - 1000,
  footprintId: '66:1234',
  state: 'running',
  holdUntilMs: null,
  discoveredAtMs: NOW - 5000,
  probe: HEVC_PROBE,
  library: {
    id: 'lib-1',
    name: 'lib',
    roots: ['/lib'],
    extensions: ['mkv'],
    companionExtensions: ['srt'],
    stagingDir: null,
    trashDir: null,
    flowId: 'flow-1',
    allowHardlinked: false,
    enabled: true,
    pausedReason: null,
    userVariables: {},
    createdAt: NOW - 10_000,
  },
  flow: { id: 'flow-1', definition: flow, definitionHash: 'flow-hash' },
  workerClass: 'transcode',
  hardwareType: 'cpu',
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  logPath: null,
  // Only first-party plugins here: nothing installed to resolve.
  pluginPaths: {},
  pluginBundles: {},
});

const payloadForFixture = (name: 'two-node-flow'): JobPayload => {
  if (name !== 'two-node-flow') throw new Error(`unknown fixture ${String(name)}`);
  return payloadFor(TWO_NODE_FLOW);
};

const inMemoryDocumentPort = (): DocumentPort => {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    get: (collection, docId) => docs.get(`${collection}:${docId}`),
    insert: (collection, docId, data) => {
      docs.set(`${collection}:${docId}`, data);
    },
    update: (collection, docId, patch) => {
      docs.set(`${collection}:${docId}`, { ...docs.get(`${collection}:${docId}`), ...patch });
    },
    removeOne: (collection, docId) => {
      docs.delete(`${collection}:${docId}`);
    },
  };
};

/** The same store, but every method answers asynchronously — as IPC would. */
const asyncDocumentPortBackedBy = (docs: Map<string, Record<string, unknown>>): DocumentPort => ({
  get: async (collection, docId) => docs.get(`${collection}:${docId}`),
  insert: async (collection, docId, data) => {
    docs.set(`${collection}:${docId}`, data);
  },
  update: async (collection, docId, patch) => {
    docs.set(`${collection}:${docId}`, { ...docs.get(`${collection}:${docId}`), ...patch });
  },
  removeOne: async (collection, docId) => {
    docs.delete(`${collection}:${docId}`);
  },
});

const quietPorts = (): RunPayloadPorts => ({
  documents: inMemoryDocumentPort(),
  onStep: () => {},
  onHeartbeat: () => {},
  onProgress: () => {},
  onLog: () => {},
  nowMs: () => NOW,
});

const writePlugin = (code: string): string => {
  const abs = join(mkdtempSync(join(tmpdir(), 'trawlarr-run-payload-plugin-')), 'index.js');
  writeFileSync(abs, code, 'utf8');
  return abs;
};

/**
 * A node that takes an output its own `details()` DECLARES to be a failure —
 * the general form of "ffmpeg exited non-zero", without needing ffmpeg. The
 * real ffmpeg case is covered end to end by `run-job.test.ts`'s Critical C1.
 */
const failingNodePath = (): string =>
  writePlugin(`
const details = () => ({
  name: 'Always Fails',
  description: 'takes an output it declares to be a failure',
  style: { borderColor: '#000000' },
  tags: 'test',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [],
  outputs: [
    { number: 1, tooltip: 'ok', outcome: 'success' },
    { number: 2, tooltip: 'failed', outcome: 'failure' },
  ],
  requiresVersion: '1.0.0',
});

const plugin = (args) => ({
  outputNumber: 2,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});

module.exports = { details, plugin };
`);

/**
 * The skip-list shape every "already processed" community plugin uses: read
 * the document store, branch on what came back. Over IPC the read is a
 * promise, which is what makes `DocumentPort` async-tolerant worth testing.
 */
const processedCheckPath = (): string =>
  writePlugin(`
const details = () => ({
  name: 'Processed Check',
  description: 'branches on a document in the plugin document store',
  style: { borderColor: '#000000' },
  tags: 'test',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [],
  outputs: [
    { number: 1, tooltip: 'already processed' },
    { number: 2, tooltip: 'not processed' },
  ],
  requiresVersion: '1.0.0',
});

const plugin = async (args) => {
  const doc = await args.deps.crudTransDBN(
    'F2FOutputJSONDB',
    'getById',
    args.inputFileObj._id,
    {},
  );
  return {
    outputNumber: doc && doc.done === true ? 1 : 2,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};

module.exports = { details, plugin };
`);

/**
 * A node that WRITES to the document store — the other half of a skip-list.
 * A write that fails must reach the plugin as a rejection rather than being
 * dropped on the floor, which is only true if `createCrudTransDbn` awaits it.
 */
const markProcessedPath = (): string =>
  writePlugin(`
const details = () => ({
  name: 'Mark Processed',
  description: 'records this file in the plugin document store',
  style: { borderColor: '#000000' },
  tags: 'test',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'recorded' }],
  requiresVersion: '1.0.0',
});

const plugin = async (args) => {
  await args.deps.crudTransDBN('F2FOutputJSONDB', 'insert', args.inputFileObj._id, { done: true });
  return {
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};

module.exports = { details, plugin };
`);

const flowEndingIn = (pluginPath: string): FlowDefinition => ({
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'last', pluginId: pluginPath, pluginVersion: '1.0.0', inputs: {} },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'last' }],
});

/** A plugin that reports which id it was reached by, through its step trace. */
const passThroughPluginPath = (): string =>
  writePlugin(`
const details = () => ({
  name: 'Installed Pass Through',
  description: 'x',
  style: { borderColor: '#000000' },
  tags: 'test',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'ok' }],
  requiresVersion: '1.0.0',
});

const plugin = (args) => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});

module.exports = { details, plugin };
`);

describe('runPayload', () => {
  it.each([
    { recoverAsSuccess: false, terminal: 'log', success: false, held: false },
    { recoverAsSuccess: true, terminal: 'log', success: true, held: false },
    { recoverAsSuccess: false, terminal: 'hold', success: false, held: true },
    { recoverAsSuccess: true, terminal: 'hold', success: false, held: true },
  ])('preserves first-party error-handler intent: %j', async (expected) => {
    const flow: FlowDefinition = {
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1', inputs: {} },
        {
          id: 'failure',
          pluginId: 'trawlarr:failFile',
          pluginVersion: '1',
          inputs: { message: 'Decoder rejected the file.' },
        },
        {
          id: 'error',
          pluginId: 'trawlarr:onError',
          pluginVersion: '1',
          inputs: { recoverAsSuccess: expected.recoverAsSuccess },
        },
        {
          id: 'log',
          pluginId: 'trawlarr:writeToLog',
          pluginVersion: '1',
          inputs: { interpolate: true, message: '{{error.message}}' },
        },
        {
          id: 'hold',
          pluginId: 'trawlarr:holdForReview',
          pluginVersion: '1',
          inputs: { reason: 'Inspect the decoder failure.' },
        },
      ],
      edges: [
        { fromNodeId: 'start', outputNumber: 1, toNodeId: 'failure' },
        { fromNodeId: 'error', outputNumber: 1, toNodeId: 'log' },
        ...(expected.terminal === 'hold'
          ? [{ fromNodeId: 'log', outputNumber: 1, toNodeId: 'hold' }]
          : []),
      ],
    };
    const report = await runPayload({ payload: payloadFor(flow), ports: quietPorts() });
    expect(report.success).toBe(expected.success);
    expect(report.held).toBe(expected.held);
    expect(report.steps.find((step) => step.nodeId === 'log')!.logExcerpt).toBe(
      'Decoder rejected the file.',
    );
    if (!expected.success && !expected.held) {
      expect(report.error).toBe('Decoder rejected the file.');
    }
    if (expected.held) expect(report.reviewReason).toBe('Inspect the decoder failure.');
  });

  it('reports a JSON-safe indefinite review hold without routing it through On Error', async () => {
    const flow: FlowDefinition = {
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
        {
          id: 'hold',
          pluginId: 'trawlarr:holdForReview',
          pluginVersion: '1.0.0',
          inputs: { reason: 'Inspect quality.' },
        },
        { id: 'error', pluginId: 'trawlarr:onError', pluginVersion: '1.0.0', inputs: {} },
      ],
      edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'hold' }],
    };
    const report = await runPayload({ payload: payloadFor(flow), ports: quietPorts() });
    expect(report).toMatchObject({
      held: true,
      reviewReason: 'Inspect quality.',
      success: false,
      stopReason: 'held-for-review',
    });
    expect(report.steps.map((step) => step.nodeId)).toEqual(['start', 'hold']);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('runs Write to Log through the durable job logger and continues successfully', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trawlarr-log-node-'));
    try {
      const definition = flowEndingIn('trawlarr:writeToLog');
      definition.nodes[1]!.inputs = { message: 'Video already matches policy.\nSkipping encode.' };
      const logs: string[] = [];
      const logPath = join(dir, 'job.log');
      const report = await runPayload({
        payload: { ...payloadFor(definition), logPath },
        ports: { ...quietPorts(), onLog: (text) => logs.push(text) },
      });
      expect(report.success).toBe(true);
      expect(report.replaced).toBeNull();
      expect(report.steps[1]!.logExcerpt).toBe('Video already matches policy.\nSkipping encode.');
      expect(logs).toContain('Video already matches policy.\nSkipping encode.');
      expect(readFileSync(logPath, 'utf8')).toContain(
        'Video already matches policy.\nSkipping encode.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports Fail File as a failed attempt, not a successful terminal step', async () => {
    const definition = flowEndingIn('trawlarr:failFile');
    definition.nodes[1]!.inputs = { message: 'No supported audio track.' };
    const report = await runPayload({ payload: payloadFor(definition), ports: quietPorts() });
    expect(report.success).toBe(false);
    expect(report.failed).toBe(true);
    expect(report.stopReason).toBe('plugin-error');
    expect(report.error).toBe('No supported audio track.');
    expect(report.outcome).toContain('No supported audio track.');
    expect(report.steps[1]).toMatchObject({
      pluginId: 'trawlarr:failFile',
      outputNumber: null,
      error: 'No supported audio track.',
      logExcerpt: 'No supported audio track.',
    });
    expect(report.replaced).toBeNull();
  });

  it('loads an INSTALLED plugin from the path the payload carries, holding no database', async () => {
    // The worker's own resolution, and the reason `pluginPaths` exists: this
    // process cannot look `tdarr:passThrough` up, so the daemon told it.
    const absPath = passThroughPluginPath();
    const payload = payloadFor(flowEndingIn('tdarr:passThrough'));
    const report = await runPayload({
      payload: { ...payload, pluginPaths: { 'tdarr:passThrough': absPath } },
      ports: quietPorts(),
    });

    expect(report.failed).toBe(false);
    expect(report.error).toBeNull();
    // The step is recorded under the ID a flow author wrote, not the path —
    // the id is the flow's identity and what a job trace must show.
    expect(report.steps.map((step) => step.pluginId)).toEqual([
      'trawlarr:start',
      'tdarr:passThrough',
    ]);
    expect(report.steps.at(-1)?.outputNumber).toBe(1);
  });

  it('fails, naming the plugin, when the id it is asked for is not in the map', async () => {
    // The control for the test above — without it, a `loadPlugin` that
    // ignored the map entirely would still look like it worked. And it is
    // the consistent answer to "no longer installed": the daemon left the id
    // out because it could not resolve it, so the run fails naming the id
    // rather than silently skipping the node.
    const report = await runPayload({
      payload: { ...payloadFor(flowEndingIn('tdarr:passThrough')), pluginPaths: {} },
      ports: quietPorts(),
    });

    expect(report.failed).toBe(true);
    expect(report.error).toContain('tdarr:passThrough');
  });

  it('still loads a plugin named by an absolute path, with an empty map', async () => {
    // A community plugin with no source at all: the path form must keep
    // working, so an id absent from the map is tried as a path rather than
    // rejected out of hand.
    const report = await runPayload({
      payload: { ...payloadFor(flowEndingIn(passThroughPluginPath())), pluginPaths: {} },
      ports: quietPorts(),
    });

    expect(report.failed).toBe(false);
    expect(report.steps).toHaveLength(2);
  });

  it('runs a flow and reports steps without touching a database', async () => {
    const steps: StepRecord[] = [];

    const report = await runPayload({
      payload: payloadForFixture('two-node-flow'),
      ports: {
        documents: inMemoryDocumentPort(),
        onStep: (step) => steps.push(step),
        onHeartbeat: () => {},
        onProgress: () => {},
        onLog: () => {},
        nowMs: () => NOW,
      },
    });

    expect(steps.map((step) => step.pluginId)).toEqual([
      'trawlarr:start',
      'trawlarr:checkVideoCodec',
    ]);
    expect(report.steps.map((step) => step.pluginId)).toEqual([
      'trawlarr:start',
      'trawlarr:checkVideoCodec',
    ]);
    expect(report.stopReason).toBe('end-of-flow');
    expect(report.success).toBe(true);
    expect(report.replaced).toBeNull();
    expect(report.postFacts).toBeNull();
    expect(report.preFacts.container).toBe('mkv');
    expect(report.preFacts.sizeBytes).toBe(4096);
    expect(report.jobId).toBe('job-1');
    expect(report.fileId).toBe('file-1');
  });

  it('produces a report that survives the IPC boundary', async () => {
    const report = await runPayload({
      payload: payloadForFixture('two-node-flow'),
      ports: quietPorts(),
    });

    // Task 5 sends this over `process.send`. A `Date`, a `Buffer` or an
    // `undefined` in a load-bearing position would arrive as something else.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('reports failure when the flow ends on an unrouted output the node calls a failure', async () => {
    const report = await runPayload({
      payload: payloadFor(flowEndingIn(failingNodePath())),
      ports: quietPorts(),
    });

    // The defect this pins: judged as "the flow ran to its end", this run
    // reads as success and stores the pre-run signature as `good`, which
    // `isKnownGood` then matches forever.
    expect(report.success).toBe(false);
    expect(report.stopReason).toBe('end-of-flow');
    expect(report.failed).toBe(false);
    expect(report.steps.at(-1)?.outputNumber).toBe(2);
    expect(report.outcome).toContain('reported failure');
  });

  it('awaits an asynchronous DocumentPort, so a plugin skip-list works over IPC', async () => {
    const port = asyncDocumentPortBackedBy(
      new Map([['F2FOutputJSONDB:/lib/movie.mkv', { done: true }]]),
    );

    const report = await runPayload({
      payload: payloadFor(flowEndingIn(processedCheckPath())),
      ports: { ...quietPorts(), documents: port },
    });

    // Without the `await` inside `createCrudTransDbn`, the plugin sees a
    // pending Promise instead of the document and takes output 2 — the
    // skip-list silently never matches and every file is reprocessed.
    expect(report.steps.at(-1)?.outputNumber).toBe(1);
  });

  it('surfaces an asynchronous write failure to the plugin instead of dropping it', async () => {
    // Not awaiting the store's write turns a failed write into an unhandled
    // rejection and lets the plugin carry on as though it had succeeded: the
    // file is marked processed in a store that never recorded it, and the
    // skip-list is wrong in the direction that silently skips work.
    const offline: DocumentPort = {
      ...inMemoryDocumentPort(),
      insert: async () => {
        await Promise.resolve();
        throw new Error('document store offline');
      },
    };

    const report = await runPayload({
      payload: payloadFor(flowEndingIn(markProcessedPath())),
      ports: { ...quietPorts(), documents: offline },
    });

    expect(report.failed).toBe(true);
    expect(report.success).toBe(false);
    expect(report.steps.at(-1)?.error).toContain('document store offline');
  });

  it('finds no document when the async store holds none, so the branch is really the store', async () => {
    const report = await runPayload({
      payload: payloadFor(flowEndingIn(processedCheckPath())),
      ports: { ...quietPorts(), documents: asyncDocumentPortBackedBy(new Map()) },
    });

    expect(report.steps.at(-1)?.outputNumber).toBe(2);
  });

  it('names each step as it starts, so progress never outlives the step that reported it', async () => {
    const events: string[] = [];

    await runPayload({
      payload: payloadForFixture('two-node-flow'),
      ports: {
        ...quietPorts(),
        onProgress: ({ percent, stage }) => events.push(`progress ${String(percent)} ${stage}`),
        onStep: (step) => events.push(`step ${step.pluginId}`),
      },
    });

    // A null percentage with each step's own name, sent BEFORE the step runs:
    // without it a job whose encode reached 100% kept showing "100% — execute"
    // through Verify, Replace and cleanup, however long they took.
    expect(events).toEqual([
      'progress null Start',
      'step trawlarr:start',
      'progress null Check Video Codec',
      'step trawlarr:checkVideoCodec',
    ]);
  });

  it('heartbeats before the first step and again after every one', async () => {
    const beats: number[] = [];
    let tick = NOW;

    const report = await runPayload({
      payload: payloadForFixture('two-node-flow'),
      ports: {
        ...quietPorts(),
        onHeartbeat: (nowMs) => beats.push(nowMs),
        nowMs: () => {
          tick += 1;
          return tick;
        },
      },
    });

    // One start-of-job beat (so a job with no steps at all is not left
    // looking stale from birth) plus one per completed step.
    expect(beats).toHaveLength(report.steps.length + 1);
    expect([...beats].sort((a, b) => a - b)).toEqual(beats);
  });
});

/**
 * THE COMMIT GATE. Before any step that can write to the library, the run
 * asks for a grant; a refusal means this worker's claim on the file was
 * released and another worker may now own it.
 *
 * The transcode cases are real runs over a real generated file — a real
 * encode, the real Verify and Replace runners — because the property that
 * matters is what is on DISK afterwards, and a stubbed runner cannot say.
 */
const execFileAsync = promisify(execFile);
const ffmpegAvailable = toolAvailableSync('ffmpeg');

/** Start -> not hevc? -> encode to hevc -> Execute -> Verify -> Replace. */
const TRANSCODE_FLOW: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'check',
      pluginId: 'trawlarr:checkVideoCodec',
      pluginVersion: '1.0.0',
      inputs: { codec: 'hevc' },
    },
    { id: 'begin', pluginId: 'trawlarr:beginCommand', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'encoder',
      pluginId: 'trawlarr:setVideoEncoder',
      pluginVersion: '1.0.0',
      inputs: { encoder: 'libx265', quality: '30' },
    },
    { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'verify',
      pluginId: 'trawlarr:verifyOutput',
      pluginVersion: '1.0.0',
      inputs: { durationToleranceSeconds: '1', minSizeRatio: '0.05' },
    },
    {
      id: 'replace',
      pluginId: 'trawlarr:replaceOriginal',
      pluginVersion: '1.0.0',
      inputs: { trashRetentionDays: '14', allowCrossDevice: 'true' },
    },
  ],
  edges: [
    { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
    { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
    { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'encoder' },
    { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'execute' },
    { fromNodeId: 'execute', outputNumber: 1, toNodeId: 'verify' },
    { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
  ],
};

/**
 * The same flow plus a flow-wide error handler that logs. Were a refused
 * commit routed like a plugin error, On Error and Write to Log would both
 * appear in the step trace.
 */
const withOnErrorNode = (payload: JobPayload): JobPayload => ({
  ...payload,
  flow: {
    ...payload.flow,
    definition: {
      nodes: [
        ...payload.flow.definition.nodes,
        { id: 'error', pluginId: 'trawlarr:onError', pluginVersion: '1.0.0', inputs: {} },
        {
          id: 'log',
          pluginId: 'trawlarr:writeToLog',
          pluginVersion: '1.0.0',
          inputs: { message: 'the error handler ran' },
        },
      ],
      edges: [
        ...payload.flow.definition.edges,
        { fromNodeId: 'error', outputNumber: 1, toNodeId: 'log' },
      ],
    },
  },
});

/** This job's scratch directories still present in the library's staging dir. */
const listStagingDirs = (payload: JobPayload): string[] => {
  const staging = resolveStagingDir({ library: payload.library, filePath: payload.path });
  if (!existsSync(staging)) return [];
  return readdirSync(staging).filter((name) => name.startsWith(workDirPrefix(payload.jobId)));
};

/** A real h264 file in a fresh library root, and a payload describing it. */
const realTranscodePayload = async (): Promise<JobPayload> => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-commit-gate-'));
  const path = join(root, 'sample.mkv');
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    path,
  ]);
  const stats = await stat(path);
  const base = payloadFor(TRANSCODE_FLOW);
  return {
    ...base,
    path,
    sizeBytes: stats.size,
    originalSizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    probe: await probeFile({ ffprobePath: 'ffprobe', path }),
    library: { ...base.library, roots: [root] },
  };
};

describe('runPayload commit gate', () => {
  it('asks with kind plugin before an installed third-party plugin, naming it as the flow does', async () => {
    const asked: { kind: string; pluginId: string }[] = [];
    const absPath = passThroughPluginPath();
    const payload = payloadFor(flowEndingIn('tdarr:passThrough'));
    const report = await runPayload({
      payload: { ...payload, pluginPaths: { 'tdarr:passThrough': absPath } },
      ports: {
        ...quietPorts(),
        commitGate: async (request) => {
          asked.push(request);
        },
      },
    });

    // Start is inert and does not ask. The installed plugin is `unknown` to
    // the engine — it can write anywhere — so it asks, by the id the flow
    // author wrote rather than the path it resolved to.
    expect(asked).toEqual([{ kind: 'plugin', pluginId: 'tdarr:passThrough' }]);
    expect(report.success).toBe(true);
  });

  it.each([
    { gate: 'refused', expected: SupersededError },
    { gate: 'unanswerable', expected: FlowAbort },
  ])('never runs a plugin whose commit is $gate, and no error handler runs', async (scenario) => {
    const marker = join(mkdtempSync(join(tmpdir(), 'trawlarr-gate-marker-')), 'ran');
    const touching = writePlugin(`
exports.details = () => ({
  name: 'Touch', description: 'x', style: {}, tags: '', isStartPlugin: false, pType: '',
  sidebarPosition: 1, icon: '', inputs: [], outputs: [{ number: 1, tooltip: 'ok' }],
  requiresVersion: '1.0.0',
});
exports.plugin = (args) => {
  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');
  return { outputNumber: 1, outputFileObj: { _id: args.inputFileObj._id }, variables: args.variables };
};
`);
    const steps: StepRecord[] = [];
    await expect(
      runPayload({
        payload: withOnErrorNode(payloadFor(flowEndingIn(touching))),
        ports: {
          ...quietPorts(),
          onStep: (step) => steps.push(step),
          commitGate: async () => {
            // An unanswerable gate (the IPC channel gone, say) has not
            // granted either, and must not fall into On Error just because
            // its failure is an ordinary Error.
            throw scenario.gate === 'refused'
              ? new SupersededError('released')
              : new Error('channel closed');
          },
        },
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof scenario.expected &&
        (scenario.gate === 'refused') === error instanceof SupersededError,
    );
    expect(existsSync(marker)).toBe(false);
    expect(steps.map((step) => step.pluginId)).toEqual(['trawlarr:start']);
  });

  it('a SupersededError carries its reason and a stable name', () => {
    const error = new SupersededError('claim released to node b');
    expect(error.reason).toBe('claim released to node b');
    expect(error.name).toBe('SupersededError');
    expect(error.message).toContain('claim released to node b');
  });

  describe.runIf(ffmpegAvailable)('on a real transcode', () => {
    it('asks the commit gate before Replace Original File and not before Execute', async () => {
      const payload = await realTranscodePayload();
      const asked: { kind: string; pluginId: string }[] = [];
      const report = await runPayload({
        payload,
        ports: {
          ...quietPorts(),
          commitGate: async (request) => {
            asked.push(request);
          },
        },
      });
      expect(asked).toEqual([{ kind: 'replace', pluginId: 'trawlarr:replaceOriginal' }]);
      expect(report.success).toBe(true);
      expect(report.replaced).not.toBeNull();
    }, 180_000);

    it('a refused gate leaves the original byte-identical, removes staging, and bypasses onFlowError', async () => {
      const payload = await realTranscodePayload();
      const before = await readFile(payload.path);
      const stepsSeen: StepRecord[] = [];
      const gate: CommitGate = async () => {
        throw new SupersededError('released');
      };
      await expect(
        runPayload({
          payload: withOnErrorNode(payload),
          ports: { ...quietPorts(), onStep: (step) => stepsSeen.push(step), commitGate: gate },
        }),
      ).rejects.toBeInstanceOf(SupersededError);

      expect(await readFile(payload.path)).toEqual(before);
      expect(listStagingDirs(payload)).toEqual([]);
      // The encode really ran and verified, so the refusal is what stopped
      // the install — not an earlier failure that would make this vacuous.
      expect(stepsSeen.map((step) => step.pluginId)).toContain('trawlarr:execute');
      expect(stepsSeen.at(-1)?.pluginId).toBe('trawlarr:verifyOutput');
      expect(stepsSeen.some((step) => step.pluginId === 'trawlarr:onError')).toBe(false);
      expect(stepsSeen.some((step) => step.pluginId === 'trawlarr:writeToLog')).toBe(false);
    }, 180_000);

    it('reports a landed replacement when a later commit is refused, instead of losing it in the abort', async () => {
      // Replace installs, then a community plugin's commit is refused (an
      // operator cancel, or a lease that ran out). Rethrowing the abort here
      // threw away `replaced`: the row was requeued with its OLD identity
      // though the file on disk had already changed.
      const payload = await realTranscodePayload();
      const before = await readFile(payload.path);
      const community = passThroughPluginPath();
      const flow = payload.flow.definition;
      const withCommunity: JobPayload = {
        ...payload,
        pluginPaths: { 'tdarr:afterReplace': community },
        flow: {
          ...payload.flow,
          definition: {
            nodes: [
              ...flow.nodes,
              {
                id: 'after',
                pluginId: 'tdarr:afterReplace',
                pluginVersion: '1.0.0',
                inputs: {},
              },
            ],
            edges: [...flow.edges, { fromNodeId: 'replace', outputNumber: 1, toNodeId: 'after' }],
          },
        },
      };
      const gate: CommitGate = async (request) => {
        if (request.kind === 'plugin') throw new SupersededError('cancelled by an operator');
      };

      const report = await runPayload({
        payload: withCommunity,
        ports: { ...quietPorts(), commitGate: gate },
      });

      expect(report.failed).toBe(true);
      expect(report.success).toBe(false);
      expect(report.superseded).toBe(true);
      expect(report.error).toContain('cancelled by an operator');
      expect(report.outcome).toContain('cancelled by an operator');
      expect(report.replaced).not.toBeNull();
      expect(report.replaced!.probe).not.toBeNull();
      expect(report.postFacts).not.toBeNull();
      expect(report.steps.map((step) => step.pluginId)).toContain('trawlarr:replaceOriginal');
      const after = await readFile(report.replaced!.path);
      expect(after.equals(before)).toBe(false);
      expect(listStagingDirs(payload)).toEqual([]);
    }, 180_000);

    it('with no commitGate port, behaves exactly as before', async () => {
      const payload = await realTranscodePayload();
      const report = await runPayload({ payload, ports: quietPorts() });
      expect(report.success).toBe(true);
      expect(report.replaced).not.toBeNull();
    }, 180_000);
  });
});

/**
 * The point of the whole task: a job can run in a process that holds no
 * database. Asserted structurally rather than in a comment — the runtime
 * module graph reachable from `run-payload.ts` must not contain a
 * repository, a connection, or the sqlite driver.
 *
 * Only VALUE imports are followed: `import type` is erased by the compiler
 * and so is not part of the runtime graph (that is exactly how `JobPayload`
 * can be shared with `job-payload.ts`, which does read the database).
 */
describe('runPayload opens no database', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  const valueImportsOf = (file: string): string[] =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('import type'))
      .flatMap((line) => [...line.matchAll(/from '([^']+)'/g)].map((match) => match[1]!));

  /** Every local file reachable from `entry` by value imports, plus the bare specifiers seen. */
  const runtimeClosure = (entry: string): { files: string[]; bare: string[] } => {
    const files: string[] = [];
    const bare: string[] = [];
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (files.includes(file)) continue;
      files.push(file);
      for (const specifier of valueImportsOf(file)) {
        if (!specifier.startsWith('.')) {
          if (!bare.includes(specifier)) bare.push(specifier);
          continue;
        }
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      }
    }
    return { files, bare };
  };

  it('imports no repository, no connection and no sqlite driver at runtime', () => {
    const { files, bare } = runtimeClosure(join(here, 'run-payload.ts'));
    const local = files.map((file) => relative(join(here, '..'), file));

    // Sanity: the walk really walked — these are run-payload's real deps.
    expect(local).toContain('library/replace-seams.ts');
    expect(local).toContain('probe/ffprobe.ts');

    expect(local.filter((file) => file.startsWith('db/'))).toEqual([]);
    expect(bare).not.toContain('better-sqlite3');
    expect(bare.filter((name) => name.includes('sqlite'))).toEqual([]);
  });

  it('is a claim that can fail: the same walk over run-job.ts does reach the database', () => {
    // Without this control, the assertion above would pass just as happily
    // against a walker that silently resolved nothing.
    const { files } = runtimeClosure(join(here, 'run-job.ts'));
    const local = files.map((file) => relative(join(here, '..'), file));

    expect(local).toContain('db/media-file-repo.ts');
    expect(local).toContain('db/job-repo.ts');
    expect(local.filter((file) => file.startsWith('db/')).length).toBeGreaterThan(1);
  });
});

/**
 * The upstream plugins that declare `outputs: []` — terminal nodes, which
 * trawlarr used to refuse to install at all. Loaded from the real corpus by
 * path, exactly as a flow refers to them, because the point of these two
 * tests is what UPSTREAM'S OWN CODE does when a flow reaches it.
 */
describe.runIf(corpusAvailable())('a flow that reaches a terminal community plugin', () => {
  it('does NOT report success when it reaches failFlow, whose whole purpose is to fail', async () => {
    const report = await runPayload({
      payload: payloadFor(flowEndingIn(pluginPath('tools/failFlow/1.0.0/index.js'))),
      ports: quietPorts(),
    });

    // The trap installing this plugin opens: it declares no outputs, so
    // "the flow stopped here" is the ONLY thing that can happen at it, and
    // "the flow stopped" is otherwise how a converged run ends. A file that
    // reached Fail Flow must never be recorded as good — the same class of
    // bug as an ffmpeg failure stored as success.
    expect(report.success).toBe(false);
    expect(report.failed).toBe(true);
    expect(report.stopReason).toBe('plugin-error');
    expect(report.steps.at(-1)?.pluginName).toBe('Fail Flow');
    expect(report.steps.at(-1)?.outputNumber).toBeNull();
    expect(report.steps.at(-1)?.error).toContain('Forcing flow to fail');
  });

  it('runs goToFlow, the other zero-output plugin, and ends the flow there', async () => {
    const report = await runPayload({
      payload: payloadFor(flowEndingIn(pluginPath('tools/goToFlow/2.0.0/index.js'))),
      ports: quietPorts(),
    });

    // It loads and runs at all, which is the fix; and being terminal, the
    // flow ends at it. Unlike failFlow it reports no failure of its own, so
    // this is an ordinary end of run.
    expect(report.steps.at(-1)?.pluginName).toBe('Go To Flow');
    expect(report.stopReason).toBe('end-of-flow');
    expect(report.success).toBe(true);
  });
});
