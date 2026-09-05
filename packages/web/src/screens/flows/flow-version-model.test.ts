import { describe, expect, it } from 'vitest';
import {
  describeRestoreConfirmation,
  describeRestorePreview,
  describeVersionNotice,
  formatWhen,
  isRestoreNoOp,
  resolveVersionStatus,
  restoreButtonLabel,
  toDiffLines,
  toVersionRows,
  type CurrentVersionState,
} from './flow-version-model.js';

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

  // Its own guard caught NaN and zero but not a magnitude out of Date's
  // range, which throws from toISOString and — during render — unmounts the
  // whole tree. Shared with every other timestamp this UI shows.
  it('renders a dash for a timestamp outside the range a Date can represent', () => {
    expect(formatWhen(8.64e15 + 1, 1000)).toBe('—');
  });

  // An unreadable clock reading costs the "Today" shortcut and nothing more:
  // the publish date is still the truth, so it is shown rather than withheld.
  it('still dates the version when now itself is unreadable', () => {
    expect(formatWhen(Date.parse('2026-08-27T03:15:00.000Z'), Number.NaN)).toBe('2026-08-27');
  });
});

describe('resolveVersionStatus', () => {
  it('is "current" when the known current id matches the version', () => {
    const current: CurrentVersionState = { kind: 'known', id: 'v2', hash: 'h2' };
    expect(resolveVersionStatus(current, 'v2')).toBe('current');
  });

  it('is "historical" when the known current id differs from the version', () => {
    const current: CurrentVersionState = { kind: 'known', id: 'v2', hash: 'h2' };
    expect(resolveVersionStatus(current, 'v1')).toBe('historical');
  });

  it('is "loading" while the lookup is in flight, not "historical"', () => {
    expect(resolveVersionStatus({ kind: 'loading' }, 'v1')).toBe('loading');
  });

  it('is "failed" when the lookup failed, not "historical"', () => {
    expect(resolveVersionStatus({ kind: 'failed' }, 'v1')).toBe('failed');
  });
});

describe('describeVersionNotice', () => {
  it('states plainly that this is the live version', () => {
    expect(describeVersionNotice('current')).toContain('current version');
  });

  it('frames a historical version as a restorable publish, not an undo', () => {
    const text = describeVersionNotice('historical');
    expect(text).toContain('HISTORICAL');
    expect(text).toContain('brand-new version');
  });

  it('says less when the check is still running, rather than guessing', () => {
    const text = describeVersionNotice('loading');
    expect(text).not.toContain('HISTORICAL');
    expect(text).not.toContain('current version of this flow — it is what runs today');
  });

  it('says less when the check failed, rather than asserting historical', () => {
    const text = describeVersionNotice('failed');
    expect(text).not.toContain('HISTORICAL');
    expect(text.toLowerCase()).toContain('could not determine');
  });
});

describe('isRestoreNoOp', () => {
  it('is true when the live definition carries the same hash as this version', () => {
    const current: CurrentVersionState = { kind: 'known', id: 'v3', hash: 'shared-hash' };
    expect(isRestoreNoOp(current, 'shared-hash')).toBe(true);
  });

  it('is true even when a DIFFERENT version row is current (A, B, A again)', () => {
    // Publish A (v1), then B (v2), then A again (v3) -- v3 is current by id,
    // but restoring v1 is still a no-op because its hash matches v3's.
    const current: CurrentVersionState = { kind: 'known', id: 'v3', hash: 'hash-a' };
    expect(isRestoreNoOp(current, 'hash-a')).toBe(true);
  });

  it('is false when the hashes differ', () => {
    const current: CurrentVersionState = { kind: 'known', id: 'v2', hash: 'hash-b' };
    expect(isRestoreNoOp(current, 'hash-a')).toBe(false);
  });

  it('is false when the current version is not known', () => {
    expect(isRestoreNoOp({ kind: 'loading' }, 'hash-a')).toBe(false);
    expect(isRestoreNoOp({ kind: 'failed' }, 'hash-a')).toBe(false);
  });
});

describe('restore preview, confirmation and button text', () => {
  it('says nothing will re-queue when no library uses the flow', () => {
    const preview = { isNoOp: false, totalFiles: 0, libraryCount: 0 };
    expect(describeRestorePreview(preview)).toBe(
      'No library currently uses this flow — restoring would re-queue nothing.',
    );
    expect(describeRestoreConfirmation(preview)).toBe(
      'No files will be re-queued — no library currently uses this flow.',
    );
    expect(restoreButtonLabel(preview, false)).toBe('Yes, restore');
  });

  it('never states a re-queue count for a no-op restore, even with a large blast radius', () => {
    // The exact case the finding names: 5,194 files across bound libraries,
    // but the definition is already live, so nothing actually re-queues.
    const preview = { isNoOp: true, totalFiles: 5194, libraryCount: 3 };
    expect(describeRestorePreview(preview)).not.toContain('5194');
    expect(describeRestoreConfirmation(preview)).not.toContain('5194');
    expect(restoreButtonLabel(preview, false)).not.toContain('5194');
    expect(restoreButtonLabel(preview, false)).toBe('Yes, restore');
    expect(describeRestoreConfirmation(preview)).toContain('already live');
  });

  it('states the real re-queue count when the hash actually differs', () => {
    const preview = { isNoOp: false, totalFiles: 5194, libraryCount: 3 };
    expect(describeRestorePreview(preview)).toContain('5194 file(s)');
    expect(describeRestoreConfirmation(preview)).toContain('5194 file(s)');
    expect(restoreButtonLabel(preview, false)).toBe('Yes, restore and re-queue 5194 file(s)');
  });

  it('shows a restoring label while the request is in flight, regardless of preview', () => {
    expect(restoreButtonLabel({ isNoOp: false, totalFiles: 5194, libraryCount: 3 }, true)).toBe(
      'Restoring…',
    );
  });

  it('pluralizes the library count correctly', () => {
    expect(describeRestorePreview({ isNoOp: false, totalFiles: 1, libraryCount: 1 })).toContain(
      '1 library',
    );
    expect(describeRestorePreview({ isNoOp: false, totalFiles: 2, libraryCount: 2 })).toContain(
      '2 libraries',
    );
  });
});

describe('toDiffLines', () => {
  it('renders a re-pointed edge as a removal and an addition', () => {
    const lines = toDiffLines({
      nodesAdded: [],
      nodesRemoved: [],
      nodePluginChanged: [],
      inputsChanged: [],
      edgesRemoved: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' }],
      edgesAdded: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'audio' }],
    });

    expect(lines).toEqual([
      { kind: 'edge-removed', text: 'check output 1 → muxqueue' },
      { kind: 'edge-added', text: 'check output 1 → audio' },
    ]);
  });

  it('renders an input change with both values', () => {
    const lines = toDiffLines({
      nodesAdded: [],
      nodesRemoved: [],
      nodePluginChanged: [],
      inputsChanged: [{ nodeId: 'lang', key: 'keepLanguages', from: 'eng', to: 'eng,kor' }],
      edgesAdded: [],
      edgesRemoved: [],
    });

    expect(lines).toEqual([{ kind: 'input-changed', text: 'lang.keepLanguages: eng → eng,kor' }]);
  });

  it('names an absent value rather than printing "null"', () => {
    const lines = toDiffLines({
      nodesAdded: [],
      nodesRemoved: [],
      nodePluginChanged: [],
      inputsChanged: [{ nodeId: 'e', key: 'quality', from: null, to: '23' }],
      edgesAdded: [],
      edgesRemoved: [],
    });

    expect(lines[0]!.text).toBe('e.quality: not set → 23');
  });

  it('returns nothing for two identical definitions', () => {
    expect(
      toDiffLines({
        nodesAdded: [],
        nodesRemoved: [],
        nodePluginChanged: [],
        inputsChanged: [],
        edgesAdded: [],
        edgesRemoved: [],
      }),
    ).toEqual([]);
  });

  it('renders node removals and additions by id', () => {
    const lines = toDiffLines({
      nodesAdded: ['audio'],
      nodesRemoved: ['muxqueue'],
      nodePluginChanged: [],
      inputsChanged: [],
      edgesAdded: [],
      edgesRemoved: [],
    });

    expect(lines).toEqual([
      { kind: 'node-removed', text: 'muxqueue removed' },
      { kind: 'node-added', text: 'audio added' },
    ]);
  });

  it('renders a plugin change with both plugin ids', () => {
    const lines = toDiffLines({
      nodesAdded: [],
      nodesRemoved: [],
      nodePluginChanged: [{ nodeId: 'check', from: 'codecCheck', to: 'codecCheckV2' }],
      inputsChanged: [],
      edgesAdded: [],
      edgesRemoved: [],
    });

    expect(lines).toEqual([{ kind: 'plugin-changed', text: 'check: codecCheck → codecCheckV2' }]);
  });

  it('orders lines nodes removed, nodes added, plugin changes, input changes, edges removed, edges added', () => {
    const lines = toDiffLines({
      nodesAdded: ['newNode'],
      nodesRemoved: ['oldNode'],
      nodePluginChanged: [{ nodeId: 'check', from: 'a', to: 'b' }],
      inputsChanged: [{ nodeId: 'lang', key: 'k', from: '1', to: '2' }],
      edgesAdded: [{ fromNodeId: 'x', outputNumber: 1, toNodeId: 'y' }],
      edgesRemoved: [{ fromNodeId: 'x', outputNumber: 1, toNodeId: 'z' }],
    });

    expect(lines.map((line) => line.kind)).toEqual([
      'node-removed',
      'node-added',
      'plugin-changed',
      'input-changed',
      'edge-removed',
      'edge-added',
    ]);
  });
});
