import { describe, expect, it } from 'vitest';
import { formatWhen, toVersionRows } from './flow-version-model.js';

const v = (id: string, hash: string, note: string, createdAt: number, isCurrent = false) => ({
  id,
  flowId: 'f1',
  definitionHash: hash,
  note,
  createdAt,
  isCurrent,
});

describe('toVersionRows', () => {
  it('shortens the hash for display while keeping the whole one', () => {
    const [row] = toVersionRows([v('a', '17dce8bd5e3482bf', 'x', 1000)], 1000);
    expect(row!.shortHash).toBe('17dce8bd');
    expect(row!.hash).toBe('17dce8bd5e3482bf');
  });

  it('marks the current version', () => {
    const rows = toVersionRows([v('a', 'h1', '', 2000, true), v('b', 'h2', '', 1000)], 2000);
    expect(rows.map((r) => r.isCurrent)).toEqual([true, false]);
  });

  it('describes an empty note as the publish it was, not as blank', () => {
    const [row] = toVersionRows([v('a', 'h', '', 1000)], 1000);
    expect(row!.note).toBe('Published');
  });

  it('keeps a real note as written', () => {
    const [row] = toVersionRows([v('a', 'h', 'Fixed the muxqueue node', 1000)], 1000);
    expect(row!.note).toBe('Fixed the muxqueue node');
  });
});

describe('formatWhen', () => {
  it('reads "Today" for a version published on the same UTC day as now', () => {
    const createdAt = Date.parse('2026-08-29T03:15:00.000Z');
    const nowMs = Date.parse('2026-08-29T20:00:00.000Z');
    expect(formatWhen(createdAt, nowMs)).toBe('Today, 03:15 UTC');
  });

  it('falls back to a plain date on a different day', () => {
    const createdAt = Date.parse('2026-08-27T03:15:00.000Z');
    const nowMs = Date.parse('2026-08-29T20:00:00.000Z');
    expect(formatWhen(createdAt, nowMs)).toBe('2026-08-27');
  });

  it('renders a missing timestamp as a dash rather than "Invalid Date"', () => {
    expect(formatWhen(0, 1000)).toBe('—');
  });
});
