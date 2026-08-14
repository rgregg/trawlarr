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

/**
 * Exported so the Replace Original File runner uses this constant — and the
 * evidence below justifying `1000 * 1000` rather than `1024 * 1024` — instead
 * of declaring a second copy that could drift from it.
 */
export const BYTES_PER_MEGABYTE = 1_000 * 1_000;

/**
 * Trawlarr keeps every size internally in bytes. The Tdarr plugin contract
 * does not: `file_object.file_size` (and, by extension, `oldSize`/`newSize`,
 * which the corpus always derives directly from `file_size`) is MEGABYTES.
 *
 * Evidence from the GPL community corpus (not shipped in this repo):
 *  - CommunityFlowPlugins/file/checkFileSize/1.0.0/index.js:75 —
 *    `var fileSizeBytes = args.inputFileObj.file_size * 1000 * 1000;`
 *  - CommunityFlowPlugins/file/compareFileSizeRatio/2.0.0/index.js —
 *    variable is misleadingly named `newFileSizeBytes`, but its own log
 *    string reads "New file has size ${newFileSizeBytes.toFixed(3)} MB".
 *  - CommunityFlowPlugins/basic/basicVideoOrAudio/1.0.0/index.js:294 —
 *    `size = args.inputFileObj.file_size;` compared against
 *    `fileSizeRangeMinMB`/`fileSizeRangeMaxMB` and logged as "${size}MB".
 *  - FlowHelpers/1.0.0/cliUtils.js:169-170 —
 *    `inputFileSize = ...file_size; inputFileSizeInGbytes = inputFileSize / 1024;`
 *  - methods/library/filters/filterBySize.js — `file.file_size / 1000 >= lowerBound`
 *    compared against a GB bound.
 *
 * Do NOT "fix" this back to bytes: that reintroduces the defect the
 * community-plugin compatibility harness exists to catch (see
 * packages/engine/test/compat/community-plugins.test.ts, "checkFileSize
 * proves file_size is projected in megabytes").
 */
const toMegabytes = (bytes: number): number => bytes / BYTES_PER_MEGABYTE;
const toBytesFromMegabytes = (megabytes: number): number => megabytes * BYTES_PER_MEGABYTE;

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
    // Tdarr contract unit: MEGABYTES. See toMegabytes() doc comment for evidence.
    file_size: toMegabytes(source.sizeBytes),
    // ffprobe's format.bit_rate is already bits/second (ffprobe's own
    // convention, not a trawlarr choice), and the corpus reads it as such:
    // CommunityFlowPlugins/video/checkOverallBitrate/1.0.0/index.js logs
    // `"File bitrate is ${args.inputFileObj.bit_rate} bps"` and compares it
    // directly against bps/kbps/mbps-scaled bounds. No conversion needed.
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
    // Tdarr contract unit: MEGABYTES, same as file_size. The corpus never
    // treats oldSize/newSize as a distinct unit — they are read as plain
    // file_size aliases (Community/Tdarr_Plugin_a9he_New_file_size_check.js:
    // `const newSize = file.file_size;` /
    // `const oldSize = otherArguments.originalLibraryFile.file_size;`, then
    // logged with an explicit "MB" suffix).
    oldSize: toMegabytes(source.originalSizeBytes),
    newSize: toMegabytes(source.sizeBytes),
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
    // `newSize` is projected in megabytes (see toMegabytes() doc comment);
    // convert back to trawlarr's internal bytes representation so a plugin
    // that merely echoes the file object back doesn't silently shrink the
    // recorded size by a factor of a million.
    //
    // Rounded at the producer: the megabyte round-trip is floating point, so a
    // 999,999-byte file comes back as 999999.0000000001. A byte count is a
    // whole number by definition and the column holding it has INTEGER
    // affinity, so rounding here is what keeps every consumer from having to
    // remember to do it. Replace Original File is what first makes non-round
    // values routine, by writing a re-stat-ed size back through this contract.
    newSizeBytes:
      typeof newSize === 'number' && Number.isFinite(newSize)
        ? Math.round(toBytesFromMegabytes(newSize))
        : null,
  };
};
