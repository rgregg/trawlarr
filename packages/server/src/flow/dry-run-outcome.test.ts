import { describe, expect, it } from 'vitest';
import type { FlowDryRunResult } from './dry-run.js';
import { classifyDryRun, outcomeKey } from './dry-run-outcome.js';

const result = (over: Partial<FlowDryRunResult>): FlowDryRunResult =>
  ({
    complete: true,
    stoppedAtNodeId: null,
    stopReason: 'end-of-flow',
    failed: false,
    error: null,
    reviewReason: null,
    wouldRunFfmpeg: false,
    executeDecisions: [],
    ...over,
  }) as FlowDryRunResult;

const ran = (encodes: { video: boolean; audio: boolean }) =>
  result({
    wouldRunFfmpeg: true,
    executeDecisions: [
      { skip: false, changes: [], nodeId: 'execute', command: ['ffmpeg'], encodes },
    ],
  } as unknown as Partial<FlowDryRunResult>);

describe('classifyDryRun', () => {
  it('a hold wins, with its reason', () => {
    expect(
      classifyDryRun(
        result({ complete: false, stopReason: 'held-for-review', reviewReason: 'Too short.' }),
      ),
    ).toEqual({
      kind: 'hold',
      detail: 'Too short.',
    });
  });

  it('a failure carries its error', () => {
    expect(classifyDryRun(result({ complete: false, failed: true, error: 'Boom.' }))).toEqual({
      kind: 'fail',
      detail: 'Boom.',
    });
  });

  it('a walk stopped at a node is incomplete, never no-change', () => {
    expect(classifyDryRun(result({ complete: false, stoppedAtNodeId: 'community' }))).toEqual({
      kind: 'incomplete',
      detail: 'community',
    });
  });

  it('names what a change re-encodes', () => {
    expect(classifyDryRun(ran({ video: true, audio: true }))).toEqual({
      kind: 'change',
      detail: 'video',
    });
    expect(classifyDryRun(ran({ video: false, audio: true }))).toEqual({
      kind: 'change',
      detail: 'audio',
    });
    expect(classifyDryRun(ran({ video: false, audio: false }))).toEqual({
      kind: 'change',
      detail: 'streams',
    });
  });

  it('otherwise nothing changes', () => {
    expect(classifyDryRun(result({}))).toEqual({ kind: 'no-change' });
  });
});

describe('outcomeKey', () => {
  it('keeps details that group, and drops per-file error text', () => {
    expect(outcomeKey({ kind: 'change', detail: 'audio' })).toBe('change:audio');
    expect(outcomeKey({ kind: 'hold', detail: 'Too short.' })).toBe('hold:Too short.');
    expect(outcomeKey({ kind: 'fail', detail: 'Boom.' })).toBe('fail');
    expect(outcomeKey({ kind: 'no-change' })).toBe('no-change');
  });
});
