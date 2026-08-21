import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import type { DocumentPort, StepRecord } from '@trawlarr/engine';
import type { JobPayload } from './job-payload.js';
import { runPayload, type RunPayloadPorts } from './run-payload.js';

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
