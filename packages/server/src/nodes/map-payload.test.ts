import { describe, expect, it } from 'vitest';
import type { FactSet, PathMapping } from '@trawlarr/core';
import type { JobPayload } from '../worker/job-payload.js';
import type { JobReport, ReplacedFile } from '../worker/run-payload.js';
import type { LibraryRecord } from '../db/library-repo.js';
import {
  libraryRootsForNode,
  payloadToNode,
  reportToServer,
  UnmappedPathError,
} from './map-payload.js';

const MAP: PathMapping[] = [{ serverPath: '/media', nodePath: '/mnt/nas' }];

const FACTS: FactSet = {
  container: 'mkv',
  sizeBytes: 4096,
  durationMs: 2000,
  width: 320,
  height: 240,
  streams: [],
};

const baseLibrary = (overrides: Partial<LibraryRecord> = {}): LibraryRecord => ({
  id: 'lib-1',
  name: 'lib',
  roots: ['/media/movies'],
  extensions: ['mkv'],
  companionExtensions: [],
  stagingDir: '/media/.stage',
  trashDir: null,
  flowId: 'flow-1',
  allowHardlinked: false,
  enabled: true,
  pausedReason: null,
  userVariables: {},
  createdAt: 0,
  ...overrides,
});

const fixturePayload = (
  overrides: Partial<Omit<JobPayload, 'library'>> & { library?: Partial<LibraryRecord> } = {},
): JobPayload => {
  const { library: libraryOverrides, ...rest } = overrides;
  return {
    jobId: 'job-1',
    fileId: 'file-1',
    libraryId: 'lib-1',
    path: '/media/movies/a.mkv',
    container: 'mkv',
    sizeBytes: 4096,
    originalSizeBytes: 4096,
    mtimeMs: 0,
    ctimeMs: 0,
    footprintId: 'inode:1',
    state: 'queued',
    holdUntilMs: null,
    discoveredAtMs: 0,
    probe: { streams: [], format: {} },
    library: baseLibrary(libraryOverrides),
    flow: { id: 'flow-1', definition: { nodes: [], edges: [] }, definitionHash: 'hash' },
    workerClass: 'transcode',
    hardwareType: 'cpu',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    logPath: '/data/logs/jobs/job-1.log',
    pluginPaths: {},
    pluginBundles: {},
    ...rest,
  };
};

const fixtureReplaced = (overrides: Partial<ReplacedFile> = {}): ReplacedFile => ({
  path: '/mnt/nas/movies/a.mp4',
  container: 'mp4',
  sizeBytes: 2048,
  mtimeMs: 0,
  ctimeMs: 0,
  nlink: 1,
  deviceId: 66,
  inode: 5678,
  hash: { sizeBytes: 2048, headHex: 'head', tailHex: 'tail' },
  probe: null,
  probeError: null,
  ...overrides,
});

const fixtureReport = (overrides: { replaced?: Partial<ReplacedFile> | null } = {}): JobReport => ({
  jobId: 'job-1',
  fileId: 'file-1',
  steps: [],
  stopReason: 'end-of-flow',
  failed: false,
  error: null,
  success: true,
  outcome: 'Flow finished: end-of-flow.',
  replaced:
    overrides.replaced === null
      ? null
      : fixtureReplaced(overrides.replaced === undefined ? {} : overrides.replaced),
  preFacts: FACTS,
  postFacts: null,
  cancelled: false,
});

describe('payloadToNode', () => {
  it('rewrites file, roots, staging and trash, and clears logPath', () => {
    const mapped = payloadToNode(
      fixturePayload({
        path: '/media/movies/a.mkv',
        library: { roots: ['/media/movies'], stagingDir: '/media/.stage', trashDir: null },
      }),
      MAP,
    );
    expect(mapped.path).toBe('/mnt/nas/movies/a.mkv');
    expect(mapped.library.roots).toEqual(['/mnt/nas/movies']);
    expect(mapped.library.stagingDir).toBe('/mnt/nas/.stage');
    expect(mapped.library.trashDir).toBeNull();
    expect(mapped.logPath).toBeNull();
  });

  it('does not mutate its input', () => {
    const original = fixturePayload();
    const originalCopy = JSON.parse(JSON.stringify(original)) as JobPayload;
    payloadToNode(original, MAP);
    expect(original).toEqual(originalCopy);
  });

  it('throws UnmappedPathError naming the path when the file is outside the map', () => {
    expect(() => payloadToNode(fixturePayload({ path: '/srv/x.mkv' }), MAP)).toThrow(
      /\/srv\/x\.mkv/,
    );
    expect(() => payloadToNode(fixturePayload({ path: '/srv/x.mkv' }), MAP)).toThrow(
      UnmappedPathError,
    );
  });

  it('an unmapped explicit staging dir is an error, not a silent fallback', () => {
    expect(() =>
      payloadToNode(fixturePayload({ library: { stagingDir: '/scratch' } }), MAP),
    ).toThrow(UnmappedPathError);
  });

  it('throws UnmappedPathError when the file would not map back to the same server path', () => {
    // Nested the same way on both sides, so validatePathMap accepts it, but
    // /media/shows/x -> /mnt/shows/x -> back through /mnt/shows -> /media/tv/x.
    const map = [
      { serverPath: '/media', nodePath: '/mnt' },
      { serverPath: '/media/tv', nodePath: '/mnt/shows' },
    ];
    const payload = fixturePayload({
      path: '/media/shows/x.mkv',
      library: { roots: ['/media'], stagingDir: null, trashDir: null },
    });
    expect(() => payloadToNode(payload, map)).toThrow(UnmappedPathError);
    expect(() => payloadToNode(payload, map)).toThrow(/\/media\/shows\/x\.mkv/);
  });

  it('throws when a library root is outside the map', () => {
    expect(() =>
      payloadToNode(fixturePayload({ library: { roots: ['/other/movies'] } }), MAP),
    ).toThrow(UnmappedPathError);
  });
});

describe('reportToServer', () => {
  it('maps a replaced path back, container change included', () => {
    const report = reportToServer(
      fixtureReport({ replaced: { path: '/mnt/nas/movies/a.mp4' } }),
      MAP,
    );
    expect(report.replaced?.path).toBe('/media/movies/a.mp4');
    expect(report.replaced?.container).toBe('mp4');
  });

  it('a report with no replacement passes through', () => {
    const report = fixtureReport({ replaced: null });
    expect(reportToServer(report, MAP)).toEqual(report);
  });

  it('throws UnmappedPathError for a replaced path outside the map', () => {
    expect(() =>
      reportToServer(fixtureReport({ replaced: { path: '/other/a.mp4' } }), MAP),
    ).toThrow(UnmappedPathError);
  });

  it('throws UnmappedPathError when the replaced path does not round-trip, rather than recording another file', () => {
    // A stored map from before validatePathMap refused inconsistent nesting.
    // `/mnt/tv/a.mp4` maps back to `/media/tv/a.mp4`, whose node path is
    // `/mnt/shows/a.mp4`: the row would take on a different file's identity.
    const legacy: PathMapping[] = [
      { serverPath: '/media', nodePath: '/mnt' },
      { serverPath: '/media/tv', nodePath: '/mnt/shows' },
    ];
    expect(() =>
      reportToServer(fixtureReport({ replaced: { path: '/mnt/tv/a.mp4' } }), legacy),
    ).toThrow(UnmappedPathError);
    expect(() =>
      reportToServer(fixtureReport({ replaced: { path: '/mnt/tv/a.mp4' } }), legacy),
    ).toThrow(/\/mnt\/tv\/a\.mp4[\s\S]*\/media\/tv\/a\.mp4/);
    // A path that does round-trip under the same map is still mapped.
    expect(
      reportToServer(fixtureReport({ replaced: { path: '/mnt/shows/a.mp4' } }), legacy).replaced
        ?.path,
    ).toBe('/media/tv/a.mp4');
  });
});

describe('libraryRootsForNode', () => {
  it('maps mapped roots and returns null for unmapped roots', () => {
    const library = baseLibrary({ roots: ['/media/movies', '/other/tv'] });
    expect(libraryRootsForNode(library, MAP)).toEqual(['/mnt/nas/movies', null]);
  });
});
