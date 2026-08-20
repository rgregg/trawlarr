import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobLogPath, sweepJobLogs } from './job-log-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('jobLogPath', () => {
  it('is one file per job under the data directory', () => {
    expect(jobLogPath({ dataDir: '/config', jobId: 'job-1' })).toBe('/config/logs/jobs/job-1.log');
  });
});

describe('sweepJobLogs', () => {
  const seed = (): { dataDir: string; nowMs: number } => {
    const dataDir = mkdtempSync(join(tmpdir(), 'trawlarr-logsweep-'));
    const dir = join(dataDir, 'logs', 'jobs');
    mkdirSync(dir, { recursive: true });
    const nowMs = Date.UTC(2026, 7, 20, 12, 0, 0);

    for (const [name, ageDays] of [
      ['old.log', 30],
      ['edge.log', 14],
      ['fresh.log', 1],
    ] as const) {
      const path = join(dir, name);
      writeFileSync(path, 'x'.repeat(100));
      const seconds = (nowMs - ageDays * DAY_MS) / 1000;
      utimesSync(path, seconds, seconds);
    }
    writeFileSync(join(dir, 'notes.txt'), 'not ours');
    return { dataDir, nowMs };
  };

  it('removes logs past the retention and keeps the rest', async () => {
    const { dataDir, nowMs } = seed();
    const result = await sweepJobLogs({ dataDir, nowMs, retentionDays: 14 });

    const dir = join(dataDir, 'logs', 'jobs');
    expect(existsSync(join(dir, 'old.log'))).toBe(false);
    // Exactly at the boundary is KEPT — the same rule the trash sweep uses.
    expect(existsSync(join(dir, 'edge.log'))).toBe(true);
    expect(existsSync(join(dir, 'fresh.log'))).toBe(true);
    expect(result).toEqual({ removed: 1, bytesFreed: 100 });
  });

  it('never touches a file it did not name', async () => {
    const { dataDir, nowMs } = seed();
    await sweepJobLogs({ dataDir, nowMs: nowMs + 365 * DAY_MS, retentionDays: 1 });
    expect(existsSync(join(dataDir, 'logs', 'jobs', 'notes.txt'))).toBe(true);
  });

  it('reports zero rather than throwing when the directory does not exist', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'trawlarr-logsweep-empty-'));
    expect(await sweepJobLogs({ dataDir, nowMs: Date.now() })).toEqual({
      removed: 0,
      bytesFreed: 0,
    });
  });
});
