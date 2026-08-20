import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJobLogWriter } from './job-log-writer.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'trawlarr-joblog-'));

describe('createJobLogWriter', () => {
  it('writes appended lines to the file', () => {
    const path = join(scratch(), 'job.log');
    const writer = createJobLogWriter({ path });
    writer.append('first');
    writer.append('second');
    writer.close();

    expect(readFileSync(path, 'utf8')).toBe('first\nsecond\n');
  });

  it('stops at the cap and says so in the file itself', () => {
    const path = join(scratch(), 'job.log');
    const writer = createJobLogWriter({ path, maxBytes: 64 });
    for (let i = 0; i < 200; i += 1) writer.append(`line ${String(i)} padding padding padding`);
    writer.close();

    const size = statSync(path).size;
    // A runaway plugin must not fill the disk; the cap is a hard byte bound
    // plus one truncation notice, so a reader knows the tail is missing.
    expect(size).toBeLessThan(64 + 200);
    expect(readFileSync(path, 'utf8')).toContain('log truncated at 64 bytes');
  });

  it('creates the parent directory rather than failing the job', () => {
    const path = join(scratch(), 'nested', 'deeper', 'job.log');
    const writer = createJobLogWriter({ path });
    writer.append('hello');
    writer.close();
    expect(readFileSync(path, 'utf8')).toBe('hello\n');
  });
});
