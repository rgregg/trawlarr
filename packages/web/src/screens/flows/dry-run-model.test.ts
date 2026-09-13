import { describe, expect, it } from 'vitest';
import {
  countLabel,
  isRunStale,
  orderedCounts,
  outcomeLabel,
  routeText,
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
