import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AgentToDaemon } from '../worker/protocol.js';

/**
 * A node process can be killed mid-job (SIGKILL, power loss, a bad update)
 * and restarted, but the daemon must still learn how that job ended: the
 * job's final `done`/`failed` message is durable-critical in a way `step`,
 * `progress` and `log` are not (see `worker/protocol.ts`). The journal is
 * that durability: one file per job under `<nodeData>/journal/`, holding the
 * final report until the daemon has acknowledged it, so a node can restart
 * between "the job finished" and "the daemon heard about it" without losing
 * the result.
 *
 * A `running` entry found on disk at startup means the agent that was
 * running it is gone — no agent survives a node restart — so `load()`
 * reports it as `lost` rather than `running`. The entry itself is left on
 * disk exactly as it was (still `state: 'running'`): the daemon has to be
 * told about the loss before the node forgets it happened, and `remove()`
 * is the only thing that clears it, called once the daemon has acked the
 * `lost` report (see the node's `welcome` handling, Task 11).
 */

export interface JournalEntry {
  jobId: string;
  state: 'running' | 'held-report';
  /** The agent's final message, kept until the server acks it. */
  final: AgentToDaemon | null;
  logLines: string[];
  logLineCount: number;
  startedAtMs: number;
}

/** Bounded tail of log lines kept per job; older lines are dropped in memory and on disk. */
export const JOURNAL_LOG_TAIL = 5_000;

export interface Journal {
  /** Entries on disk at startup; any 'running' entry becomes 'lost' here, because no agent survives a node restart. */
  load(): { jobId: string; state: 'running' | 'held-report' | 'lost'; logLineCount: number }[];
  begin(jobId: string, nowMs: number): void;
  appendLog(jobId: string, line: string): void;
  hold(jobId: string, final: AgentToDaemon): void;
  get(jobId: string): JournalEntry | null;
  linesFrom(jobId: string, fromLine: number): { fromLine: number; lines: string[] };
  remove(jobId: string): void;
}

/**
 * A jobId arrives over the network (it names the file this reads and
 * writes), so it is validated as a single, safe path component before it
 * ever reaches `join()` — never trusted to already be one.
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const assertSafeJobId = (jobId: string): void => {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Unsafe journal jobId: ${JSON.stringify(jobId)}`);
  }
};

const ENTRY_SUFFIX = '.json';

const isJournalEntry = (value: unknown): value is JournalEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['jobId'] !== 'string') return false;
  if (record['state'] !== 'running' && record['state'] !== 'held-report') return false;
  if (
    !Array.isArray(record['logLines']) ||
    !record['logLines'].every((l) => typeof l === 'string')
  ) {
    return false;
  }
  if (typeof record['logLineCount'] !== 'number') return false;
  if (typeof record['startedAtMs'] !== 'number') return false;
  if (record['final'] !== null && typeof record['final'] !== 'object') return false;
  return true;
};

/**
 * Rewrites the on-disk file at most once per second while a job is
 * `running`: log lines are liveness-only (see `worker/protocol.ts`), so
 * losing the last fraction of a second of them to a crash costs nothing a
 * human cares about, and a once-per-second cap keeps a chatty plugin from
 * turning every log line into an fsync. `hold()` and `remove()` bypass the
 * throttle and always write synchronously, because the held report and the
 * entry's removal ARE durability-critical.
 */
const FLUSH_INTERVAL_MS = 1_000;

export const createJournal = (dir: string): Journal => {
  mkdirSync(dir, { recursive: true });

  const memory = new Map<string, JournalEntry>();
  const lastFlushMs = new Map<string, number>();

  const entryPath = (jobId: string): string => join(dir, `${jobId}${ENTRY_SUFFIX}`);

  const writeEntry = (entry: JournalEntry): void => {
    const tmp = join(dir, `.${entry.jobId}.tmp-${randomBytes(6).toString('hex')}`);
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, entryPath(entry.jobId));
  };

  const requireEntry = (jobId: string): JournalEntry => {
    const entry = memory.get(jobId);
    if (entry === undefined) {
      throw new Error(`No journal entry for job "${jobId}"`);
    }
    return entry;
  };

  return {
    load() {
      const results: {
        jobId: string;
        state: 'running' | 'held-report' | 'lost';
        logLineCount: number;
      }[] = [];
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return results;
        throw error;
      }
      for (const name of names) {
        // A torn write leaves only its temp file (named with a leading
        // dot and a `.tmp-<random>` suffix, never `.json`) or, at worst,
        // an incomplete `.json` file that fails to parse below — both are
        // skipped rather than surfaced, because `writeEntry` never renames
        // a partial write into place.
        if (!name.endsWith(ENTRY_SUFFIX) || name.startsWith('.')) continue;
        const jobId = name.slice(0, -ENTRY_SUFFIX.length);
        if (!JOB_ID_PATTERN.test(jobId)) continue;
        let raw: string;
        try {
          raw = readFileSync(join(dir, name), 'utf8');
        } catch {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!isJournalEntry(parsed) || parsed.jobId !== jobId) continue;
        memory.set(jobId, parsed);
        results.push({
          jobId,
          state: parsed.state === 'running' ? 'lost' : parsed.state,
          logLineCount: parsed.logLineCount,
        });
      }
      return results;
    },

    begin(jobId, nowMs) {
      assertSafeJobId(jobId);
      const entry: JournalEntry = {
        jobId,
        state: 'running',
        final: null,
        logLines: [],
        logLineCount: 0,
        startedAtMs: nowMs,
      };
      memory.set(jobId, entry);
      writeEntry(entry);
      lastFlushMs.set(jobId, Date.now());
    },

    appendLog(jobId, line) {
      assertSafeJobId(jobId);
      const entry = requireEntry(jobId);
      entry.logLines.push(line);
      if (entry.logLines.length > JOURNAL_LOG_TAIL) {
        entry.logLines.splice(0, entry.logLines.length - JOURNAL_LOG_TAIL);
      }
      entry.logLineCount += 1;

      const now = Date.now();
      const last = lastFlushMs.get(jobId) ?? 0;
      if (now - last >= FLUSH_INTERVAL_MS) {
        lastFlushMs.set(jobId, now);
        writeEntry(entry);
      }
    },

    hold(jobId, final) {
      assertSafeJobId(jobId);
      const entry = requireEntry(jobId);
      entry.state = 'held-report';
      entry.final = final;
      writeEntry(entry);
      lastFlushMs.set(jobId, Date.now());
    },

    get(jobId) {
      assertSafeJobId(jobId);
      const entry = memory.get(jobId);
      if (entry === undefined) return null;
      return { ...entry, logLines: [...entry.logLines] };
    },

    linesFrom(jobId, fromLine) {
      assertSafeJobId(jobId);
      const entry = memory.get(jobId);
      if (entry === undefined) return { fromLine, lines: [] };
      const tailStart = entry.logLineCount - entry.logLines.length;
      const effectiveFrom = Math.max(fromLine, tailStart);
      const offset = effectiveFrom - tailStart;
      return { fromLine: effectiveFrom, lines: entry.logLines.slice(offset) };
    },

    remove(jobId) {
      assertSafeJobId(jobId);
      memory.delete(jobId);
      lastFlushMs.delete(jobId);
      try {
        rmSync(entryPath(jobId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
};
