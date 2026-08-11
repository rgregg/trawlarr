export interface ProbeStreamTags {
  language?: string;
  title?: string;
  [key: string]: string | undefined;
}

/**
 * A raw ffprobe stream. The open index signature is deliberate: community
 * plugins read arbitrary ffprobe fields, so narrowing this would break them.
 */
export interface ProbeStream {
  codec_name: string;
  codec_type: string;
  bit_rate?: number;
  channels?: number;
  tags?: ProbeStreamTags;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface ProbeFormat {
  filename?: string;
  nb_streams?: number;
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  [key: string]: string | number | undefined;
}

export interface ProbeData {
  streams?: ProbeStream[];
  format?: ProbeFormat;
}

export type HealthCheckStatus = '' | 'Hold' | 'Queued' | 'Success' | 'Error' | 'Cancelled';

export type TranscodeDecision =
  | ''
  | 'Hold'
  | 'Queued'
  | 'Transcode success'
  | 'Transcode error'
  | 'Transcode cancelled'
  | 'Not required';

export interface StatSyncLike {
  mtimeMs: number;
  ctimeMs: number;
}

export interface ScannerReads {
  ffProbeRead: string;
  exiftoolRead: string;
  mediaInfoRead: string;
  closedCaptionRead: string;
}

/**
 * The per-job view of a file handed to plugins. `_id` is the file's PATH,
 * not a stable identifier — trawlarr's stable identity is projected into
 * `footprintId`. The open index signature is required: plugins read fields
 * we do not enumerate.
 */
export interface PluginFileObject {
  _id: string;
  file: string;
  DB: string;
  footprintId: string;
  container: string;
  createdAt: number;
  file_size: number;
  bit_rate: number;
  statSync: StatSyncLike;
  scannerReads: ScannerReads;
  ffProbeData: ProbeData;
  meta?: Record<string, unknown>;
  mediaInfo?: Record<string, unknown>;
  hasClosedCaptions: boolean;
  bumped: boolean;
  HealthCheck: HealthCheckStatus;
  TranscodeDecisionMaker: TranscodeDecision;
  holdUntil: number;
  fileMedium: string;
  video_codec_name: string;
  audio_codec_name: string;
  video_resolution: string;
  videoStreamIndex: number;
  lastHealthCheckDate: number;
  lastTranscodeDate: number;
  history: string;
  oldSize: number;
  newSize: number;
  lastPluginDetails: string;
  [key: string]: unknown;
}
