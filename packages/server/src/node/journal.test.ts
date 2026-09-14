import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentToDaemon } from '../worker/protocol.js';
import { JOURNAL_LOG_TAIL, createJournal } from './journal.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trawlarr-journal-'));
});

afterEach(() => {
  // Best-effort; a temp dir leaking on failure is not worth failing the test over.
});

const DONE: AgentToDaemon = {
  type: 'done',
  report: {} as never,
};

describe('createJournal', () => {
  it('begin -> hold -> reload reports held-report and keeps the final report', () => {
    const journal = createJournal(dir);
    journal.begin('job-1', 1_000);
    journal.hold('job-1', DONE);

    const reopened = createJournal(dir);
    const loaded = reopened.load();
    expect(loaded).toEqual([{ jobId: 'job-1', state: 'held-report', logLineCount: 0 }]);
    expect(reopened.get('job-1')?.final).toEqual(DONE);
    expect(reopened.get('job-1')?.state).toBe('held-report');
  });

  it('begin alone -> reload reports lost', () => {
    const journal = createJournal(dir);
    journal.begin('job-2', 2_000);

    const reopened = createJournal(dir);
    const loaded = reopened.load();
    expect(loaded).toEqual([{ jobId: 'job-2', state: 'lost', logLineCount: 0 }]);
    // The entry is kept on disk (still 'running') until the server acks the
    // loss and the caller calls remove() — never silently rewritten.
    expect(reopened.get('job-2')?.state).toBe('running');
  });

  it('appendLog keeps a bounded tail and an exact total count', () => {
    const journal = createJournal(dir);
    journal.begin('job-3', 0);

    const total = JOURNAL_LOG_TAIL + 10;
    for (let i = 0; i < total; i += 1) {
      journal.appendLog('job-3', `line-${i}`);
    }

    const entry = journal.get('job-3');
    expect(entry?.logLineCount).toBe(total);
    expect(entry?.logLines.length).toBe(JOURNAL_LOG_TAIL);
    expect(entry?.logLines[0]).toBe('line-10');
    expect(entry?.logLines[entry.logLines.length - 1]).toBe(`line-${total - 1}`);

    const lastTen = journal.linesFrom('job-3', total - 10);
    expect(lastTen.fromLine).toBe(total - 10);
    expect(lastTen.lines).toEqual(Array.from({ length: 10 }, (_, i) => `line-${total - 10 + i}`));

    const clamped = journal.linesFrom('job-3', 0);
    expect(clamped.fromLine).toBe(total - JOURNAL_LOG_TAIL);
    expect(clamped.lines.length).toBe(JOURNAL_LOG_TAIL);
    expect(clamped.lines[0]).toBe('line-10');
  });

  it('ignores a leftover temp file from a torn write on load', () => {
    const journal = createJournal(dir);
    journal.begin('job-4', 3_000);

    // Simulate a write that died between writeFileSync and renameSync.
    writeFileSync(join(dir, '.job-5.tmp-deadbeef'), '{"broken');
    // And a same-extension file that is simply corrupt.
    writeFileSync(join(dir, 'job-6.json'), '{not json');

    const reopened = createJournal(dir);
    const loaded = reopened.load();

    expect(loaded).toEqual([{ jobId: 'job-4', state: 'lost', logLineCount: 0 }]);
    expect(reopened.get('job-5')).toBeNull();
    expect(reopened.get('job-6')).toBeNull();
    // The torn temp file itself is untouched (still lying around, ignored).
    expect(readdirSync(dir)).toContain('.job-5.tmp-deadbeef');
  });

  it('remove deletes the on-disk entry and forgets it in memory', () => {
    const journal = createJournal(dir);
    journal.begin('job-7', 4_000);
    journal.remove('job-7');

    expect(journal.get('job-7')).toBeNull();
    const reopened = createJournal(dir);
    expect(reopened.load()).toEqual([]);
  });

  it('rejects an unsafe jobId', () => {
    const journal = createJournal(dir);
    expect(() => journal.begin('../etc/passwd', 0)).toThrow();
    expect(() => journal.appendLog('a/b', 'x')).toThrow();
    expect(() => journal.get('')).toThrow();
  });
});
