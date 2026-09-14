import { describe, expect, it } from 'vitest';
import {
  MAX_FRAME_BYTES,
  parseNodeFrame,
  parseServerFrame,
  type HelloFrame,
  type NodeConfigFrame,
} from './node-frames.js';

const hello: HelloFrame = {
  type: 'hello',
  protocolVersion: 2,
  buildVersion: '1.2.0',
  hardwareTypes: ['cpu', 'nvenc'],
  hardwareCaps: { nvenc: 2 },
  ffmpegPath: '/usr/bin/ffmpeg',
  ffprobePath: '/usr/bin/ffprobe',
  jobs: [{ jobId: 'job-1', state: 'running', logLineCount: 12 }],
};

const config: NodeConfigFrame = {
  type: 'config',
  nodeId: 'node-1',
  schedule: { timezone: 'UTC', baseCounts: { transcode: 1, health: 1 }, windows: [] },
  paused: false,
  pathMap: [{ serverPath: '/media', nodePath: '/mnt/media' }],
  libraries: [{ libraryId: 'lib-1', name: 'Movies', nodeRoots: ['/mnt/media/movies', null] }],
};

describe('parseNodeFrame', () => {
  it('parses a valid hello frame', () => {
    expect(parseNodeFrame(JSON.stringify(hello))).toEqual(hello);
  });

  it('rejects hello with a non-number protocolVersion', () => {
    expect(parseNodeFrame(JSON.stringify({ ...hello, protocolVersion: '2' }))).toBeNull();
  });

  it('rejects hello with an unknown hardware type', () => {
    expect(
      parseNodeFrame(JSON.stringify({ ...hello, hardwareTypes: ['cpu', 'not-a-gpu'] })),
    ).toBeNull();
  });

  it('drops an agent frame whose inner message fails parseAgentMessage', () => {
    expect(
      parseNodeFrame(JSON.stringify({ type: 'agent', jobId: 'job-1', message: { type: 'ready' } })),
    ).toBeNull();
  });

  it('parses a valid agent frame', () => {
    const frame = { type: 'agent', jobId: 'job-1', message: { type: 'ready', pid: 42 } };
    expect(parseNodeFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('parses a libraries frame', () => {
    const frame = {
      type: 'libraries',
      libraries: [{ libraryId: 'lib-1', reachable: true, detail: 'ok' }],
    };
    expect(parseNodeFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('parses a job-state frame', () => {
    const frame = { type: 'job-state', jobId: 'job-1', state: 'held-report' };
    expect(parseNodeFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('rejects a job-state frame with an unknown state', () => {
    expect(
      parseNodeFrame(JSON.stringify({ type: 'job-state', jobId: 'job-1', state: 'zombie' })),
    ).toBeNull();
  });

  it('parses a log-backfill frame', () => {
    const frame = { type: 'log-backfill', jobId: 'job-1', fromLine: 3, lines: ['a', 'b'] };
    expect(parseNodeFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('rejects log-backfill with a non-string line', () => {
    expect(
      parseNodeFrame(
        JSON.stringify({ type: 'log-backfill', jobId: 'job-1', fromLine: 0, lines: ['a', 2] }),
      ),
    ).toBeNull();
  });

  it('returns null for non-JSON text', () => {
    expect(parseNodeFrame('not json {{{')).toBeNull();
  });

  it('returns null for oversized text without calling JSON.parse', () => {
    const huge = '"' + 'x'.repeat(MAX_FRAME_BYTES + 1) + '"';
    expect(parseNodeFrame(huge)).toBeNull();
  });

  it('round-trips every node frame type', () => {
    const frames = [
      hello,
      { type: 'agent', jobId: 'job-1', message: { type: 'heartbeat', nowMs: 1 } },
      { type: 'libraries', libraries: [{ libraryId: 'lib-1', reachable: false, detail: 'down' }] },
      { type: 'job-state', jobId: 'job-1', state: 'lost' },
      { type: 'log-backfill', jobId: 'job-1', fromLine: 0, lines: [] },
    ];
    for (const frame of frames) {
      expect(parseNodeFrame(JSON.stringify(frame))).toEqual(frame);
    }
  });
});

describe('parseServerFrame', () => {
  it('parses a config frame', () => {
    expect(parseServerFrame(JSON.stringify(config))).toEqual(config);
  });

  it('parses a welcome frame', () => {
    const frame = {
      type: 'welcome',
      config,
      jobs: [{ jobId: 'job-1', action: 'continue', logLinesHave: 10 }],
    };
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('parses a refused frame', () => {
    const frame = { type: 'refused', reason: 'unknown node', retryAfterMs: 5000 };
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('parses a job frame', () => {
    const frame = { type: 'job', jobId: 'job-1', payload: { jobId: 'job-1' } };
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('rejects a job frame whose payload.jobId does not match the frame jobId', () => {
    expect(
      parseServerFrame(
        JSON.stringify({ type: 'job', jobId: 'job-1', payload: { jobId: 'job-2' } }),
      ),
    ).toBeNull();
  });

  it('parses an agent frame carrying a DaemonToAgent message', () => {
    const frame = { type: 'agent', jobId: 'job-1', message: { type: 'cancel' } };
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('rejects an agent frame whose inner message is a job', () => {
    expect(
      parseServerFrame(
        JSON.stringify({ type: 'agent', jobId: 'job-1', message: { type: 'job', payload: {} } }),
      ),
    ).toBeNull();
  });

  it('parses an abandon frame', () => {
    const frame = { type: 'abandon', jobId: 'job-1', reason: 'superseded' };
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('parses an ack-report frame', () => {
    const frame = { type: 'ack-report', jobId: 'job-1' };
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('returns null for non-JSON text', () => {
    expect(parseServerFrame('not json {{{')).toBeNull();
  });

  it('returns null for oversized text without calling JSON.parse', () => {
    const huge = '"' + 'x'.repeat(MAX_FRAME_BYTES + 1) + '"';
    expect(parseServerFrame(huge)).toBeNull();
  });

  it('round-trips every server frame type', () => {
    const frames = [
      config,
      { type: 'welcome', config, jobs: [] },
      { type: 'refused', reason: 'no', retryAfterMs: 1000 },
      { type: 'job', jobId: 'job-1', payload: { jobId: 'job-1' } },
      {
        type: 'agent',
        jobId: 'job-1',
        message: { type: 'commit-result', id: 1, granted: true, reason: null },
      },
      { type: 'abandon', jobId: 'job-1', reason: 'x' },
      { type: 'ack-report', jobId: 'job-1' },
    ];
    for (const frame of frames) {
      expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
    }
  });
});
