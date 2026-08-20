import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const JOB_LOG_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One file per job, named by job id, under the data directory (spec 3.4). */
export const jobLogPath = (input: { dataDir: string; jobId: string }): string =>
  join(input.dataDir, 'logs', 'jobs', `${input.jobId}.log`);

/**
 * Drop job logs older than the retention.
 *
 * ONLY `*.log` ENTRIES ARE CONSIDERED, on the same principle as the trash
 * sweep: a directory trawlarr writes into may also contain something a human
 * put there, and a sweep that deletes what it did not create is a sweep
 * nobody can trust with a path. An entry exactly at the boundary is kept.
 */
export const sweepJobLogs = async (input: {
  dataDir: string;
  nowMs: number;
  retentionDays?: number;
}): Promise<{ removed: number; bytesFreed: number }> => {
  const dir = join(input.dataDir, 'logs', 'jobs');
  const cutoff = input.nowMs - (input.retentionDays ?? JOB_LOG_RETENTION_DAYS) * DAY_MS;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: 0, bytesFreed: 0 };
  }

  let removed = 0;
  let bytesFreed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoff) continue;
      await rm(path, { force: true });
      removed += 1;
      bytesFreed += info.size;
    } catch {
      // One unreadable log must not cost the others their sweep.
    }
  }
  return { removed, bytesFreed };
};
