import type { ProbeData, ProbeStream } from '@trawlarr/plugin-api';
import { canonicalJson, sha256Hex } from './canonical-json.js';

export interface StreamFact {
  index: number;
  codecType: string;
  codecName: string;
  language: string | null;
  disposition: string | null;
}

export interface FactSet {
  container: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  streams: StreamFact[];
}

export interface FactTolerance {
  /** Absolute duration drift, in milliseconds, treated as no change. */
  durationMs: number;
  /** Fractional size drift treated as no change. */
  sizeRatio: number;
}

export const DEFAULT_FACT_TOLERANCE: FactTolerance = {
  durationMs: 1_000,
  sizeRatio: 0.01,
};

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Collapse ffprobe's disposition map to the flags that are set, sorted. */
const dispositionOf = (stream: ProbeStream): string | null => {
  const raw = stream.disposition;
  if (raw === null || typeof raw !== 'object') return null;
  const flags = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => v === 1 || v === true)
    .map(([k]) => k)
    .sort();
  return flags.length > 0 ? flags.join(',') : null;
};

const firstVideoStream = (streams: ProbeStream[]): ProbeStream | undefined =>
  streams.find((s) => s.codec_type === 'video');

export const extractFacts = (input: {
  probe: ProbeData;
  container: string;
  sizeBytes: number;
}): FactSet => {
  const streams = input.probe.streams ?? [];
  const video = firstVideoStream(streams);
  const durationSeconds = numberOrNull(input.probe.format?.duration);

  return {
    container: input.container,
    sizeBytes: input.sizeBytes,
    durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
    width: numberOrNull(video?.width),
    height: numberOrNull(video?.height),
    streams: streams.map((stream, index) => ({
      index,
      codecType: stream.codec_type ?? '',
      codecName: stream.codec_name ?? '',
      language: stream.tags?.language ?? null,
      disposition: dispositionOf(stream),
    })),
  };
};

const streamsEquivalent = (a: StreamFact[], b: StreamFact[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((left, i) => {
    const right = b[i];
    return (
      right !== undefined &&
      left.index === right.index &&
      left.codecType === right.codecType &&
      left.codecName === right.codecName &&
      left.language === right.language &&
      left.disposition === right.disposition
    );
  });
};

/**
 * Did anything meaningful change between two runs? Used by convergence
 * detection, so it is deliberately tolerant of the incidental drift a
 * lossless remux produces while remaining strict about codecs, streams
 * and container.
 */
export const factsEquivalent = (
  a: FactSet,
  b: FactSet,
  tolerance: FactTolerance = DEFAULT_FACT_TOLERANCE,
): boolean => {
  if (a.container !== b.container) return false;
  if (a.width !== b.width || a.height !== b.height) return false;

  if ((a.durationMs === null) !== (b.durationMs === null)) return false;
  if (
    a.durationMs !== null &&
    b.durationMs !== null &&
    Math.abs(a.durationMs - b.durationMs) >= tolerance.durationMs
  ) {
    return false;
  }

  const largest = Math.max(a.sizeBytes, b.sizeBytes);
  if (largest > 0) {
    const drift = Math.abs(a.sizeBytes - b.sizeBytes) / largest;
    if (drift > tolerance.sizeRatio) return false;
  }

  return streamsEquivalent(a.streams, b.streams);
};

/** Exact hash of the fact set, used by the ledger signature. */
export const factsHash = (facts: FactSet): string => sha256Hex(canonicalJson(facts));
