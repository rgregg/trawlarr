import { platform, arch } from 'node:os';
import type {
  ConfigVars,
  PluginDeps,
  PluginFileObject,
  PluginInputArgs,
  RunVariables,
} from '@trawlarr/plugin-api';
import { rejectClassicPluginDeps } from './deps.js';

export interface BuildArgsInput {
  fileObject: PluginFileObject;
  originalFileObject: PluginFileObject;
  nodeInputs: Record<string, unknown>;
  variables: RunVariables;
  librarySettings: Record<string, unknown>;
  userVariables: { global: Record<string, string>; library: Record<string, string> };
  configVars: ConfigVars;
  deps: PluginDeps;
  workDir: string;
  jobId: string;
  footprintId: string;
  fileId: string;
  jobStartMs: number;
  workerClass: string;
  hardwareType: string;
  log: (text: string) => void;
  onWorkerUpdate?: (obj: Record<string, unknown>) => void;
  probeFile?: (path: string) => Promise<PluginFileObject>;
}

export const buildPluginInputArgs = (input: BuildArgsInput): PluginInputArgs => {
  const config = input.configVars.config;

  return {
    inputFileObj: input.fileObject,
    originalLibraryFile: input.originalFileObject,
    librarySettings: input.librarySettings,
    inputs: input.nodeInputs,
    userVariables: input.userVariables,
    variables: input.variables,
    config: config as unknown as Record<string, unknown>,
    configVars: input.configVars,

    workDir: input.workDir,
    platform: platform(),
    arch: arch(),
    platform_arch_isdocker: config.platform_arch_isdocker,
    ffmpegPath: config.ffmpegPath,
    handbrakePath: config.handbrakePath,
    mkvpropeditPath: config.mkvpropeditPath,
    nodeHardwareType: input.hardwareType,
    workerType: input.workerClass,
    job: {
      version: '1.0.0',
      footprintId: input.footprintId,
      jobId: input.jobId,
      start: input.jobStartMs,
      type: input.workerClass,
      fileId: input.fileId,
    },
    isAutomation: false,
    logFullCliOutput: false,

    jobLog: input.log,
    updateWorker: (obj) => input.onWorkerUpdate?.(obj),
    logOutcome: (outcome) => input.log(`Outcome: ${outcome}`),
    updateStat: async () => {},
    scanIndividualFile:
      input.probeFile === undefined ? undefined : async (file) => input.probeFile!(file._id),
    installClassicPluginDeps: rejectClassicPluginDeps,

    lastSuccesfulPlugin: null,
    lastSuccessfulRun: null,
    thisPlugin: null,

    deps: input.deps,
  };
};
