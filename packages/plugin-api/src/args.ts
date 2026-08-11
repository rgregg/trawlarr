import type { PluginFileObject, ProbeData } from './file-object.js';
import type { FfmpegCommand } from './ffmpeg.js';

export interface LiveSizeCompare {
  enabled: boolean;
  compareMethod: string;
  thresholdPerc: number;
  lowerThresholdPerc: number;
  checkDelaySeconds: number;
  error: boolean;
  errorType: '' | 'upperThreshold' | 'lowerThreshold';
}

export interface RunVariables {
  ffmpegCommand: FfmpegCommand;
  flowFailed: boolean;
  user: Record<string, string>;
  healthCheck?: 'Success';
  queueTags?: string;
  liveSizeCompare?: LiveSizeCompare;
  removeFromTdarr?: boolean;
  automation?: Record<string, unknown>;
}

export interface JobDescriptor {
  version: string;
  footprintId: string;
  jobId: string;
  start: number;
  type: string;
  fileId: string;
}

export interface PathTranslator {
  server: string;
  node: string;
}

export interface ConfigVars {
  config: {
    nodeID: string;
    nodeName: string;
    serverURL: string;
    serverIP: string;
    serverPort: string;
    handbrakePath: string;
    ffmpegPath: string;
    mkvpropeditPath: string;
    pathTranslators: PathTranslator[];
    platform_arch_isdocker: string;
    logLevel: string;
    processPid: number;
    priority: number;
    apiKey: string;
    maxLogSizeMB: number;
    pollInterval: number;
    /**
     * Upstream vocabulary, exposed only here. Trawlarr's UI and docs say
     * "Direct access" and "File transfer" instead (spec §4.8).
     */
    nodeType: 'mapped' | 'unmapped';
    unmappedNodeCache: string;
    startPaused: boolean;
  };
}

export type CrudMode = 'getById' | 'insert' | 'update' | 'removeOne';

export interface PluginDeps {
  fsextra: unknown;
  gracefulfs: unknown;
  upath: unknown;
  axios: unknown;
  ncp: unknown;
  mvdir: unknown;
  parseArgsStringToArgv: (input: string) => string[];
  importFresh: (path: string) => unknown;
  requireFromString: (pluginText: string, relativePath: string) => Record<string, unknown>;
  axiosMiddleware: (endpoint: string, data: Record<string, unknown>) => Promise<unknown>;
  crudTransDBN: (
    collection: string,
    mode: CrudMode,
    docID: string,
    obj: Record<string, unknown>,
  ) => Promise<unknown>;
  configVars: ConfigVars;
}

export interface ScanTypes {
  scanIndividualFile?: boolean;
  [key: string]: unknown;
}

export interface PluginInputArgs {
  inputFileObj: PluginFileObject;
  originalLibraryFile: PluginFileObject;
  librarySettings: Record<string, unknown>;
  inputs: Record<string, unknown>;
  userVariables: { global: Record<string, string>; library: Record<string, string> };
  variables: RunVariables;
  config: Record<string, unknown>;
  configVars: ConfigVars;

  workDir: string;
  platform: string;
  arch: string;
  platform_arch_isdocker: string;
  ffmpegPath: string;
  handbrakePath: string;
  mkvpropeditPath: string;
  nodeHardwareType: string;
  workerType: string;
  nodeTags?: string;
  job: JobDescriptor;
  isAutomation: boolean;
  logFullCliOutput: boolean;

  jobLog: (text: string) => void;
  updateWorker: (obj: Record<string, unknown>) => void;
  logOutcome: (outcome: string) => void;
  updateStat: (db: string, key: string, inc: number) => Promise<void>;
  scanIndividualFile?: (
    file: { _id: string; file: string; DB: string; footprintId: string },
    scanTypes: ScanTypes,
  ) => Promise<PluginFileObject>;
  /** Always rejects: classic plugins are out of scope (spec §2.8). */
  installClassicPluginDeps: (deps: string[]) => Promise<never>;

  /** Upstream spelling preserved: plugins read `lastSuccesfulPlugin`. */
  lastSuccesfulPlugin: unknown;
  lastSuccessfulRun: unknown;
  thisPlugin: unknown;

  deps: PluginDeps;
}

export interface PluginOutputArgs {
  outputNumber: number;
  outputFileObj: { _id: string };
  variables: RunVariables;
}

export type { ProbeData };
