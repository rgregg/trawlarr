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
  //
  // Defence in depth: `validatePathMap` now refuses any map where this can
  // happen, so for a validated map this should be unreachable. It stays for
  // a map stored before that rule existed (and the hub refuses to offer such
  // a node work at all — see `NodeRecord.pathMapError`).
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
 *
 * `replaced.path` is where a plugin chose to put its output, not a path the
 * server sent, so the round-trip guard in `payloadToNode` never saw it. It
 * gets its own: under a map with inconsistent nesting, `/mnt/tv/x` maps back
 * to `/media/tv/x`, whose node path is `/mnt/shows/x` — and the row would
 * record the identity of a file the node never touched. A validated map
 * cannot do this; a map stored before `validatePathMap` refused it can, and
 * the throw settles the job as a failed attempt (`remote-agent`'s `done`).
 */
export const reportToServer = (report: JobReport, map: readonly PathMapping[]): JobReport => {
  if (report.replaced === null) return report;
  const nodePath = report.replaced.path;
  const serverPath = toServerOrThrow(map, nodePath);
  const again = mapPath(map, serverPath, 'toNode');
  if (again !== nodePath) {
    throw new UnmappedPathError(
      nodePath,
      `The replacement at "${nodePath}" on the node maps to "${serverPath}" on the server, which ` +
        `maps back to "${String(again)}" rather than the same node path. Fix the node's path map ` +
        `so its nested entries sit at the same place on both sides.`,
    );
  }
  return { ...report, replaced: { ...report.replaced, path: serverPath } };
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
