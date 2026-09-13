import { describe, expect, it } from 'vitest';
import {
  changedFileCount,
  changeGroupLabel,
  countLabel,
  formatCount,
  isRunStale,
  orderedCounts,
  outcomeLabel,
  progressText,
  publishDryRunSummary,
  routeText,
  type DryRunChangeGroup,
  type DryRunRun,
  type DryRunWalk,
} from './dry-run-model.js';

describe('outcomeLabel', () => {
  it('labels every outcome, terse and exact', () => {
    expect(outcomeLabel({ kind: 'no-change' })).toBe('No change');
    expect(outcomeLabel({ kind: 'change', detail: 'video' })).toBe('Re-encode video');
    expect(outcomeLabel({ kind: 'change', detail: 'audio' })).toBe('Convert audio');
    expect(outcomeLabel({ kind: 'change', detail: 'streams' })).toBe('Remux');
    expect(outcomeLabel({ kind: 'hold', detail: 'Review requested by the flow.' })).toBe(
      'Hold: Review requested by the flow.',
    );
    expect(outcomeLabel({ kind: 'fail', detail: 'ffprobe timed out' })).toBe('Fail');
    expect(outcomeLabel({ kind: 'incomplete', detail: 'checkVideoCodec-1' })).toBe(
      'Stops at checkVideoCodec-1',
    );
  });
});

describe('countLabel', () => {
  it('agrees with outcomeLabel for the equivalent outcome', () => {
    expect(countLabel('no-change')).toBe('No change');
    expect(countLabel('change:video')).toBe('Re-encode video');
    expect(countLabel('change:audio')).toBe('Convert audio');
    expect(countLabel('change:streams')).toBe('Remux');
    expect(countLabel('hold:Needs review')).toBe('Hold: Needs review');
    expect(countLabel('fail')).toBe('Fail');
    expect(countLabel('incomplete:begin-command-1')).toBe('Stops at begin-command-1');
  });
});

describe('orderedCounts', () => {
  it('orders no change, re-encode/convert/remux, holds, incomplete, fail', () => {
    expect(
      orderedCounts({ fail: 1, 'no-change': 3, 'change:video': 2 }).map((entry) => entry.key),
    ).toEqual(['no-change', 'change:video', 'fail']);
  });

  it('places the full ordering: no-change, change kinds, holds, incomplete, fail', () => {
    const counts = {
      fail: 1,
      'incomplete:begin-command-1': 1,
      'hold:Needs review': 1,
      'change:streams': 1,
      'change:audio': 1,
      'change:video': 1,
      'no-change': 1,
    };
    expect(orderedCounts(counts).map((entry) => entry.key)).toEqual([
      'no-change',
      'change:video',
      'change:audio',
      'change:streams',
      'hold:Needs review',
      'incomplete:begin-command-1',
      'fail',
    ]);
  });

  it('carries a label that agrees with countLabel', () => {
    const [entry] = orderedCounts({ 'change:video': 5 });
    expect(entry).toEqual({ key: 'change:video', label: 'Re-encode video', count: 5 });
  });
});

describe('isRunStale', () => {
  const run = { definitionHash: 'def-1', publishedHash: 'pub-1' };

  it('is not stale when the canvas and published hashes both still match', () => {
    expect(isRunStale(run, 'def-1', 'pub-1')).toBe(false);
  });

  it('is stale once the canvas has been edited since the run started', () => {
    expect(isRunStale(run, 'def-2', 'pub-1')).toBe(true);
  });

  it('is stale when the canvas has never been validated (hash unknown)', () => {
    expect(isRunStale(run, null, 'pub-1')).toBe(true);
  });

  it('is stale once the flow has been published again since the run started', () => {
    expect(isRunStale(run, 'def-1', 'pub-2')).toBe(true);
  });
});

describe('routeText', () => {
  const labels = { 'start-1': 'Start', 'check-video-1': 'Check Video Codec' };

  it('joins step labels with an arrow', () => {
    const walk: DryRunWalk = {
      steps: [
        { nodeId: 'start-1', outputNumber: 1, error: null },
        { nodeId: 'check-video-1', outputNumber: 2, error: null },
      ],
      plannedCommands: [],
      partialWalkWarning: null,
    };
    expect(routeText(walk, labels)).toBe('Start → Check Video Codec');
  });

  it('falls back to the raw node id when it has no label', () => {
    const walk: DryRunWalk = {
      steps: [
        { nodeId: 'start-1', outputNumber: 1, error: null },
        { nodeId: 'custom-node-7', outputNumber: null, error: 'boom' },
      ],
      plannedCommands: [],
      partialWalkWarning: null,
    };
    expect(routeText(walk, labels)).toBe('Start → custom-node-7');
  });

  it('is empty for a walk that never happened', () => {
    expect(routeText(null, labels)).toBe('');
  });
});

const filesOf = (count: number): DryRunChangeGroup['files'] =>
  Array.from({ length: count }, (_, index) => ({
    fileId: `f${String(index)}`,
    path: `/m/${String(index)}.mkv`,
  }));

const group = (
  count: number,
  to: DryRunChangeGroup['to'] = { kind: 'change', detail: 'streams' },
): DryRunChangeGroup => ({ from: { kind: 'no-change' }, to, files: filesOf(count) });

const doneRun = (changes: DryRunChangeGroup[], overrides: Partial<DryRunRun> = {}): DryRunRun => ({
  runId: 'r1',
  flowId: 'flow-1',
  status: 'done',
  error: null,
  processed: 10,
  total: 10,
  definitionHash: 'def-1',
  publishedHash: 'pub-1',
  counts: {},
  changes,
  files: [],
  ...overrides,
});

describe('formatting', () => {
  it('groups thousands the same regardless of browser locale', () => {
    expect(formatCount(5242)).toBe('5,242');
    expect(formatCount(0)).toBe('0');
  });

  it('prints progress as processed over total', () => {
    expect(progressText({ processed: 1850, total: 5242 })).toBe('Dry run · 1,850 / 5,242');
  });

  it('summarises a change group as count, from, to', () => {
    expect(changeGroupLabel(group(12))).toBe('12 · No change → Remux');
    expect(
      changeGroupLabel({
        from: { kind: 'change', detail: 'video' },
        to: { kind: 'hold', detail: 'Check it' },
        files: filesOf(1),
      }),
    ).toBe('1 · Re-encode video → Hold: Check it');
  });

  it('counts every file across every change group', () => {
    expect(changedFileCount({ changes: [group(3), group(2)] })).toBe(5);
    expect(changedFileCount({ changes: [] })).toBe(0);
  });
});

describe('publishDryRunSummary', () => {
  it('names the changed-file total and the top three groups for a current done run', () => {
    const run = doneRun([
      group(12),
      group(5, { kind: 'change', detail: 'video' }),
      group(2, { kind: 'change', detail: 'audio' }),
      group(1, { kind: 'fail', detail: 'x' }),
    ]);
    expect(publishDryRunSummary(run, 'def-1', 'pub-1')).toEqual({
      line: 'Dry run: 20 file(s) change outcome.',
      groups: [
        '12 · No change → Remux',
        '5 · No change → Re-encode video',
        '2 · No change → Convert audio',
      ],
    });
  });

  it('still speaks for a run where nothing changes', () => {
    expect(publishDryRunSummary(doneRun([]), 'def-1', 'pub-1')).toEqual({
      line: 'Dry run: 0 file(s) change outcome.',
      groups: [],
    });
  });

  it('says nothing without a run, for an unfinished run, or for a stale one', () => {
    expect(publishDryRunSummary(null, 'def-1', 'pub-1')).toBeNull();
    expect(publishDryRunSummary(doneRun([], { status: 'running' }), 'def-1', 'pub-1')).toBeNull();
    expect(publishDryRunSummary(doneRun([], { status: 'cancelled' }), 'def-1', 'pub-1')).toBeNull();
    expect(publishDryRunSummary(doneRun([]), 'def-2', 'pub-1')).toBeNull();
    expect(publishDryRunSummary(doneRun([]), 'def-1', 'pub-2')).toBeNull();
    expect(publishDryRunSummary(doneRun([]), null, 'pub-1')).toBeNull();
  });
});
