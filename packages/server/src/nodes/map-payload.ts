import { mapPath, type PathMapping } from '@trawlarr/core';
import type { JobPayload } from '../worker/job-payload.js';
import type { JobReport } from '../worker/run-payload.js';
import type { LibraryRecord } from '../db/library-repo.js';

/**
 * A server path with no entry in a node's path map.
 *
 * Thrown rather than silently passed through: a node running against the
 * server's literal path would operate on whatever that path means on its
 * own disk (AGENTS.md: "a path the map doesn't cover must be an error").
 */
export class UnmappedPathError extends Error {
  readonly path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Path "${path}" is outside the node's path map.`);
    this.path = path;
  }
}

const toNodeOrThrow = (map: readonly PathMapping[], path: string): string => {
  const mapped = mapPath(map, path, 'toNode');
  if (mapped === null) throw new UnmappedPathError(path);
  return mapped;
};

const toServerOrThrow = (map: readonly PathMapping[], path: string): string => {
  const mapped = mapPath(map, path, 'toServer');
  if (mapped === null) throw new UnmappedPathError(path);
  return mapped;
};

/**
 * Every server path in the payload rewritten for the node.
 *
 * `logPath` is set to null rather than mapped: the node host assigns its own
 * log path (the node, not the server, owns where its on-disk log lives), and
 * the server writes its copy from frames sent back over the wire (Task 8).
 *
 * `configVars`/`pluginPaths`/`ffmpegPath`/`ffprobePath` are untouched here —
 * see the task brief for why each is the node host's job, not this one's.
 */
export const payloadToNode = (payload: JobPayload, map: readonly PathMapping[]): JobPayload => {
  const nodePath = toNodeOrThrow(map, payload.path);
  // The report comes back through `reportToServer`'s longest-prefix lookup,
  // not this one. A map whose entries overlap can send `/media/shows/x` to
  // `/mnt/shows/x` and bring that back as `/media/tv/x` — recording the
  // result against a different file. Refused before the job is sent.
  if (mapPath(map, nodePath, 'toServer') !== payload.path) {
    throw new UnmappedPathError(
      payload.path,
      `Path "${payload.path}" maps to "${nodePath}" on the node, which does not map back to the ` +
        `same server path. Fix the node's path map so its entries do not overlap.`,
    );
  }
  return mapPayload(payload, map, nodePath);
};

const mapPayload = (
  payload: JobPayload,
  map: readonly PathMapping[],
  nodePath: string,
): JobPayload => ({
  ...payload,
  path: nodePath,
  library: {
    ...payload.library,
    roots: payload.library.roots.map((root) => toNodeOrThrow(map, root)),
    stagingDir:
      payload.library.stagingDir === null ? null : toNodeOrThrow(map, payload.library.stagingDir),
    trashDir:
      payload.library.trashDir === null ? null : toNodeOrThrow(map, payload.library.trashDir),
  },
  logPath: null,
});

/**
 * The report's paths rewritten back to the server's own view.
 *
 * Only `replaced.path` carries a persisted path a node could have produced;
 * step records carry no paths of their own (`StepRecord.logExcerpt` is free
 * text, written as-is).
 */
export const reportToServer = (report: JobReport, map: readonly PathMapping[]): JobReport => {
  if (report.replaced === null) return report;
  return {
    ...report,
    replaced: { ...report.replaced, path: toServerOrThrow(map, report.replaced.path) },
  };
};

/**
 * Library roots as the node sees them, one entry per server root. A `null`
 * marks a root the map does not cover — the caller decides whether that is
 * fatal for the job at hand, rather than this function silently dropping it.
 */
export const libraryRootsForNode = (
  library: LibraryRecord,
  map: readonly PathMapping[],
): (string | null)[] => library.roots.map((root) => mapPath(map, root, 'toNode'));
