import type {
  HealthCheckStatus,
  PluginFileObject,
  ProbeData,
  ProbeStream,
  TranscodeDecision,
} from '@trawlarr/plugin-api';
import type { FileState } from '@trawlarr/core';

export interface ProjectionSource {
  fileId: string;
  libraryId: string;
  /** Trawlarr's stable identity — deliberately not the path. */
  footprintId: string;
  path: string;
  container: string;
  sizeBytes: number;
  originalSizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  probe: ProbeData;
  exiftool?: Record<string, unknown>;
  mediainfo?: Record<string, unknown>;
  state: FileState;
  /** Whether the most recent successful run modified the file. */
  lastRunModified: boolean;
  healthStatus?: HealthCheckStatus;
  holdUntilMs: number | null;
  lastTranscodeMs: number | null;
  lastHealthCheckMs: number | null;
  history: string;
  discoveredAtMs: number;
}

export interface AbsorbedChanges {
  path: string;
  healthStatus: HealthCheckStatus;
  transcodeDecision: TranscodeDecision;
  holdUntilMs: number | null;
  bumped: boolean;
  newSizeBytes: number | null;
}

const HEALTH_VALUES = new Set<HealthCheckStatus>([
  '',
  'Hold',
  'Queued',
  'Success',
  'Error',
  'Cancelled',
]);

const DECISION_VALUES = new Set<TranscodeDecision>([
  '',
  'Hold',
  'Queued',
  'Transcode success',
  'Transcode error',
  'Transcode cancelled',
  'Not required',
]);

/**
 * Trawlarr's ledger is the source of truth, but plugins branch on these two
 * legacy strings, so the ledger is projected into them on the way out and
 * their writes are absorbed on the way back in.
 */
export const projectTranscodeDecision = (
  state: FileState,
  lastRunModified: boolean,
): TranscodeDecision => {
  switch (state) {
    case 'good':
      return lastRunModified ? 'Transcode success' : 'Not required';
    case 'queued':
      return 'Queued';
    case 'held':
      return 'Hold';
    case 'failed':
    case 'not_converging':
      return 'Transcode error';
    default:
      return '';
  }
};

const videoStreamIndexOf = (streams: ProbeStream[]): number => {
  const index = streams.findIndex((s) => s.codec_type === 'video');
  return index === -1 ? 0 : index;
};

/** Resolution labels follow the vocabulary community plugins already compare against. */
const resolutionLabel = (width: number | undefined, height: number | undefined): string => {
  if (typeof width !== 'number' || typeof height !== 'number') return '';
  if (width >= 7000) return '8KUHD';
  if (width >= 3000) return '4KUHD';
  if (width >= 1800) return '1080p';
  if (width >= 1200) return '720p';
  if (width >= 1000) return '576p';
  if (width >= 700) return '480p';
  return 'other';
};

const numeric = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const toPluginFileObject = (source: ProjectionSource): PluginFileObject => {
  const streams = source.probe.streams ?? [];
  const videoIndex = videoStreamIndexOf(streams);
  const video = streams[videoIndex];
  const audio = streams.find((s) => s.codec_type === 'audio');

  const file: PluginFileObject = {
    _id: source.path,
    file: source.path,
    DB: source.libraryId,
    footprintId: source.footprintId,
    container: source.container,
    createdAt: source.discoveredAtMs,
    file_size: source.sizeBytes,
    bit_rate: numeric(source.probe.format?.bit_rate),
    statSync: { mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs },
    scannerReads: {
      ffProbeRead: source.probe.streams === undefined ? 'false' : 'true',
      exiftoolRead: source.exiftool === undefined ? 'false' : 'true',
      mediaInfoRead: source.mediainfo === undefined ? 'false' : 'true',
      closedCaptionRead: 'false',
    },
    ffProbeData: source.probe,
    hasClosedCaptions: false,
    bumped: false,
    HealthCheck: source.healthStatus ?? '',
    TranscodeDecisionMaker: projectTranscodeDecision(source.state, source.lastRunModified),
    holdUntil: source.holdUntilMs ?? 0,
    fileMedium: video === undefined ? 'audio' : 'video',
    video_codec_name: video?.codec_name ?? '',
    audio_codec_name: audio?.codec_name ?? '',
    video_resolution: resolutionLabel(video?.width, video?.height),
    videoStreamIndex: videoIndex,
    lastHealthCheckDate: source.lastHealthCheckMs ?? 0,
    lastTranscodeDate: source.lastTranscodeMs ?? 0,
    history: source.history,
    oldSize: source.originalSizeBytes,
    newSize: source.sizeBytes,
    lastPluginDetails: '',
  };

  if (source.exiftool !== undefined) file.meta = source.exiftool;
  if (source.mediainfo !== undefined) file.mediaInfo = source.mediainfo;

  return file;
};

export const absorbPluginFileObject = (fileObject: PluginFileObject): AbsorbedChanges => {
  const health = fileObject.HealthCheck as unknown;
  const decision = fileObject.TranscodeDecisionMaker as unknown;
  const hold = fileObject.holdUntil as unknown;
  const newSize = fileObject.newSize as unknown;

  return {
    path: typeof fileObject._id === 'string' ? fileObject._id : '',
    healthStatus:
      typeof health === 'string' && HEALTH_VALUES.has(health as HealthCheckStatus)
        ? (health as HealthCheckStatus)
        : '',
    transcodeDecision:
      typeof decision === 'string' && DECISION_VALUES.has(decision as TranscodeDecision)
        ? (decision as TranscodeDecision)
        : '',
    holdUntilMs: typeof hold === 'number' && Number.isFinite(hold) && hold > 0 ? hold : null,
    bumped: fileObject.bumped === true,
    newSizeBytes: typeof newSize === 'number' && Number.isFinite(newSize) ? newSize : null,
  };
};
