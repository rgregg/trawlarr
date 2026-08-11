#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { ConfigVars, ProbeData } from '@trawlarr/plugin-api';
import type { FlowDefinition } from '@trawlarr/core';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import { buildPluginDeps } from './host/deps.js';
import { createCrudTransDbn } from './host/crud-trans-dbn.js';
import { createAxiosMiddleware } from './host/axios-middleware.js';
import { buildPluginInputArgs } from './host/args.js';
import { toPluginFileObject } from './host/file-object.js';
import { createPluginLoader, type LoadedPlugin } from './host/loader.js';
import { createExecuteRunner } from './executor/execute-node.js';
import { runFlow } from './executor/run-flow.js';
import { runDryFlow } from './executor/dry-run.js';

const execFileAsync = promisify(execFile);

const probe = async (ffprobePath: string, file: string): Promise<ProbeData> => {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return JSON.parse(stdout) as ProbeData;
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      flow: { type: 'string' },
      file: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      ffmpeg: { type: 'string', default: 'ffmpeg' },
      ffprobe: { type: 'string', default: 'ffprobe' },
      'work-dir': { type: 'string' },
    },
  });

  if (values.flow === undefined || values.file === undefined) {
    console.error('Usage: trawlarr-engine --flow <flow.json> --file <media> [--dry-run]');
    return 2;
  }

  const flow = JSON.parse(await readFile(values.flow, 'utf8')) as FlowDefinition;
  const workDir = values['work-dir'] ?? mkdtempSync(join(tmpdir(), 'trawlarr-job-'));
  const stat = statSync(values.file);
  const probeData = await probe(values.ffprobe!, values.file);

  const fileObject = toPluginFileObject({
    fileId: 'cli-file',
    libraryId: 'cli-library',
    footprintId: `${stat.dev}:${stat.ino}`,
    path: values.file,
    container: extname(values.file).replace('.', ''),
    sizeBytes: stat.size,
    originalSizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    probe: probeData,
    state: 'unknown',
    lastRunModified: false,
    holdUntilMs: null,
    lastTranscodeMs: null,
    lastHealthCheckMs: null,
    history: '',
    discoveredAtMs: Date.now(),
  });

  const log = (text: string) => console.log(`  ${text}`);
  const documents = new Map<string, Record<string, unknown>>();
  let paused = false;

  const configVars: ConfigVars = {
    config: {
      nodeID: 'cli',
      nodeName: 'cli',
      serverURL: '',
      serverIP: '',
      serverPort: '',
      handbrakePath: 'HandBrakeCLI',
      ffmpegPath: values.ffmpeg!,
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
  };

  const deps = buildPluginDeps({
    configVars,
    crudTransDBN: createCrudTransDbn({
      documents: {
        get: (c, d) => documents.get(`${c}::${d}`),
        insert: (c, d, data) => void documents.set(`${c}::${d}`, data),
        update: (c, d, patch) =>
          void documents.set(`${c}::${d}`, { ...(documents.get(`${c}::${d}`) ?? {}), ...patch }),
        removeOne: (c, d) => void documents.delete(`${c}::${d}`),
      },
      hostSettings: {
        setPauseAllNodes: (value) => {
          paused = value;
          log(`Plugin ${value ? 'paused' : 'unpaused'} all nodes.`);
        },
        getPauseAllNodes: () => paused,
      },
      log,
      nowMs: () => Date.now(),
    }),
    axiosMiddleware: createAxiosMiddleware({
      probeFile: (path) => probe(values.ffprobe!, path),
      log,
    }),
  });

  const outputPathFor = (path: string, container: string) =>
    join(workDir, `${basename(path, extname(path))}.${container || 'mkv'}`);

  const loader = createPluginLoader();
  const executeRunner = createExecuteRunner({
    ffmpegPath: values.ffmpeg!,
    outputPathFor,
    log,
  });

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
      const substitute = executeRunner(base);
      return substitute === null ? base : { ...base, module: substitute };
    }
    return loader.load(node.pluginId);
  };

  const buildArgs = (invocation: {
    node: { inputs: Record<string, unknown> };
    currentPath: string;
    variables: Parameters<typeof buildPluginInputArgs>[0]['variables'];
  }) =>
    buildPluginInputArgs({
      fileObject: { ...fileObject, _id: invocation.currentPath, file: invocation.currentPath },
      originalFileObject: fileObject,
      nodeInputs: invocation.node.inputs,
      variables: invocation.variables,
      librarySettings: {},
      userVariables: { global: {}, library: {} },
      configVars,
      deps,
      workDir,
      jobId: 'cli-job',
      footprintId: fileObject.footprintId,
      fileId: 'cli-file',
      jobStartMs: Date.now(),
      workerClass: 'transcode',
      hardwareType: 'cpu',
      log,
    });

  const options = { flow, initialPath: values.file, loadPlugin, buildArgs };
  const result = values['dry-run']
    ? await runDryFlow({ ...options, outputPathFor })
    : await runFlow(options);

  console.log('\nStep trace:');
  for (const step of result.steps) {
    const routed = step.outputNumber === null ? 'error' : `output ${step.outputNumber}`;
    console.log(`  ${step.seq}. ${step.pluginName} → ${routed} (${step.durationMs}ms)`);
    if (step.error !== null) console.log(`     error: ${step.error}`);
  }

  if (values['dry-run'] === true && 'plannedCommands' in result) {
    const dryResult = result as unknown as Awaited<ReturnType<typeof runDryFlow>>;
    for (const args of dryResult.plannedCommands) {
      console.log(`\nWould run: ${values.ffmpeg} ${args.join(' ')}`);
    }
    if (dryResult.stoppedBecause !== null) console.log(`\n${dryResult.stoppedBecause}`);
  }

  console.log(`\nStopped: ${result.stopReason}`);
  console.log(`Result path: ${result.currentPath}`);
  return result.failed ? 1 : 0;
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
