import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import type { DocumentPort } from '@trawlarr/engine';
import { observeCurrentFile } from './fresh-observation.js';
import { runPayload } from './run-payload.js';
import type { JobPayload } from './job-payload.js';

const NOW = 1_700_000_000_000;

const VC1: ProbeData = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'vc1', width: 320, height: 240 },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '2.0', size: '4096' },
};
const HEVC: ProbeData = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 320, height: 240 },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '2.0', size: '2048' },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A file on disk that the row below still describes as the pre-transcode VC-1 original. */
const staleRow = (): { path: string; payload: JobPayload; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-fresh-obs-'));
  dirs.push(dir);
  const path = join(dir, 'movie.mkv');
  writeFileSync(path, 'x'.repeat(2048));
  const payload = {
    jobId: 'job-2',
    fileId: 'file-1',
    libraryId: 'lib-1',
    path,
    container: 'mkv',
    sizeBytes: 4096,
    originalSizeBytes: 4096,
    mtimeMs: NOW - 5000,
    ctimeMs: NOW - 5000,
    footprintId: '1:1',
    state: 'running',
    holdUntilMs: null,
    discoveredAtMs: NOW - 9000,
    probe: VC1,
    ffprobePath: 'ffprobe',
    ffmpegPath: 'ffmpeg',
  } as unknown as JobPayload;
  return { path, payload, dir };
};

describe('observeCurrentFile', () => {
  it('keeps the payload when the file is as the row describes it', async () => {
    const { payload, path } = staleRow();
    const stats = { size: payload.sizeBytes, mtimeMs: payload.mtimeMs, ctimeMs: payload.ctimeMs };
    const probed: string[] = [];

    const seen = await observeCurrentFile({
      payload,
      log: () => {},
      stat: async (p) => {
        expect(p).toBe(path);
        return stats;
      },
      probe: async ({ path: p }) => {
        probed.push(p);
        return HEVC;
      },
    });

    expect(probed).toEqual([]);
    expect(seen.probe).toBe(VC1);
  });

  it('probes again when the file on disk is not the one the row describes', async () => {
    // The retry after an identity conflict: the first attempt installed the
    // HEVC file, the reconcile failed, and the row still says VC-1.
    const { payload } = staleRow();
    const logged: string[] = [];

    const seen = await observeCurrentFile({
      payload,
      log: (text) => logged.push(text),
      stat: async () => ({ size: 2048, mtimeMs: NOW, ctimeMs: NOW }),
      probe: async () => HEVC,
    });

    expect(seen.probe).toBe(HEVC);
    expect(seen.sizeBytes).toBe(2048);
    expect(seen.mtimeMs).toBe(NOW);
    expect(logged.join('\n')).toMatch(/probed again/);
  });

  it('says the modification time changed when the size did not', async () => {
    const { payload } = staleRow();
    const logged: string[] = [];

    await observeCurrentFile({
      payload,
      log: (text) => logged.push(text),
      stat: async () => ({ size: payload.sizeBytes, mtimeMs: NOW, ctimeMs: NOW }),
      probe: async () => HEVC,
    });

    expect(logged.join('\n')).toMatch(/modified .* then, .* now/);
    expect(logged.join('\n')).not.toMatch(/bytes then/);
  });

  it('refuses to run on stale facts when the changed file cannot be probed', async () => {
    const { payload } = staleRow();

    await expect(
      observeCurrentFile({
        payload,
        log: () => {},
        stat: async () => ({ size: 2048, mtimeMs: NOW, ctimeMs: NOW }),
        probe: async () => {
          throw new Error('ffprobe failed');
        },
      }),
    ).rejects.toThrow(/could not be probed again/);
  });

  it('keeps the payload when the file cannot be stat-ed', async () => {
    const { payload } = staleRow();

    const seen = await observeCurrentFile({
      payload,
      log: () => {},
      stat: async () => {
        throw new Error('ENOENT');
      },
    });

    expect(seen.probe).toBe(VC1);
  });
});

describe('runPayload after a failed reconcile', () => {
  it('starts the flow from the current file, not the row it was built from', async () => {
    const { payload, dir } = staleRow();
    // A stand-in ffprobe that reports what is really on disk now.
    const fakeFfprobe = join(dir, 'ffprobe.sh');
    writeFileSync(fakeFfprobe, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(HEVC)}\nEOF\n`);
    chmodSync(fakeFfprobe, 0o755);

    const flow: FlowDefinition = {
      nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
      edges: [],
    };
    const docs = new Map<string, Record<string, unknown>>();
    const documents: DocumentPort = {
      get: (c, d) => docs.get(`${c}:${d}`),
      insert: (c, d, data) => {
        docs.set(`${c}:${d}`, data);
      },
      update: (c, d, patch) => {
        docs.set(`${c}:${d}`, { ...docs.get(`${c}:${d}`), ...patch });
      },
      removeOne: (c, d) => {
        docs.delete(`${c}:${d}`);
      },
    };

    const report = await runPayload({
      payload: {
        ...payload,
        ffprobePath: fakeFfprobe,
        library: {
          id: 'lib-1',
          name: 'lib',
          roots: [dir],
          extensions: ['mkv'],
          companionExtensions: [],
          stagingDir: null,
          trashDir: null,
          flowId: 'flow-1',
          allowHardlinked: false,
          enabled: true,
          pausedReason: null,
          userVariables: {},
          plex: null,
          runtime: { kind: null, url: '', apiKey: '', percent: 5, minutes: 3 },
          createdAt: NOW,
        },
        flow: { id: 'flow-1', definition: flow, definitionHash: 'h' },
        workerClass: 'transcode',
        hardwareType: 'cpu',
        logPath: null,
        pluginPaths: {},
        pluginBundles: {},
      } as JobPayload,
      ports: {
        documents,
        onStep: () => {},
        onHeartbeat: () => {},
        onProgress: () => {},
        onLog: () => {},
        nowMs: () => NOW,
      },
    });

    const video = report.preFacts.streams.find((s) => s.codecType === 'video');
    expect(video?.codecName).toBe('hevc');
  });
});
