import { describe, expect, it } from 'vitest';
import type { ScanSummary } from '../scanner/scan-library.js';
import { createEventBus, type TrawlarrEvent } from '../daemon/events.js';
import { createDaemonAlerts, subscribeDaemonAlerts } from './daemon-alerts.js';
import type { AlertInput } from './alert-service.js';

const MIN = 60_000;

const summaryOf = (rootsUnavailable: number): ScanSummary =>
  ({ rootsUnavailable }) as unknown as ScanSummary;

const setup = (
  options: {
    startupDelayMs?: number;
    nodeOfflineGraceMs?: number;
    raise?: (i: AlertInput) => void;
  } = {},
) => {
  let now = 10 * MIN;
  const raised: AlertInput[] = [];
  const bus = createEventBus();
  const alerts = createDaemonAlerts({
    bus,
    service: {
      raise: (input) => {
        raised.push(input);
        options.raise?.(input);
      },
    },
    describe: {
      library: (id) => (id === 'gone' ? undefined : `Lib ${id}`),
      node: (id) => (id === 'gone' ? undefined : `Node ${id}`),
      file: (id) => (id === 'gone' ? undefined : { path: `/m/${id}.mkv`, libraryId: 'l1' }),
    },
    nowMs: () => now,
    startupDelayMs: options.startupDelayMs ?? 0,
    nodeOfflineGraceMs: options.nodeOfflineGraceMs ?? 5 * MIN,
  });
  const emit = (event: TrawlarrEvent): void => bus.emit(event);
  return {
    alerts,
    bus,
    emit,
    raised,
    names: () => raised.map((r) => r.event),
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const finished = (state: 'failed' | 'not_converging' | 'good' | 'held', outcome = 'boom') =>
  ({ type: 'job.finished', jobId: 'j1', fileId: 'f1', state, outcome }) as const;

describe('daemon alerts: files', () => {
  it('raises file.failed and file.not_converging with a reason, and nothing for other states', () => {
    const t = setup();
    t.emit(finished('failed', 'disk full'));
    t.emit(finished('not_converging', 'keeps changing'));
    t.emit(finished('good'));
    t.emit(finished('held'));
    expect(t.raised).toHaveLength(2);
    expect(t.raised[0]).toMatchObject({
      event: 'file.failed',
      scope: 'l1',
      reason: 'disk full',
      path: '/m/f1.mkv',
      library: 'Lib l1',
      jobId: 'j1',
    });
    expect(t.raised[1]).toMatchObject({ event: 'file.not_converging', reason: 'keeps changing' });
  });

  it('never leaves the reason empty, and survives a file that no longer exists', () => {
    const t = setup();
    t.emit({ type: 'job.finished', jobId: 'j', fileId: 'gone', state: 'failed', outcome: '  ' });
    expect(t.raised[0]?.reason).toBeTruthy();
    expect(t.raised[0]?.summary).toContain('gone');
  });
});

describe('daemon alerts: root missing and aborted scans', () => {
  it('raises root_missing only (never scan.aborted) and recovers on a clean scan', () => {
    const t = setup();
    t.emit({ type: 'scan.finished', libraryId: 'l1', summary: summaryOf(1) });
    expect(t.names()).toEqual(['library.root_missing']);
    t.emit({ type: 'scan.finished', libraryId: 'l1', summary: summaryOf(0) });
    expect(t.names()).toEqual(['library.root_missing', 'library.root_missing.recovered']);
  });

  it('never raises a recovery for a condition it did not raise', () => {
    const t = setup();
    t.emit({ type: 'scan.finished', libraryId: 'l1', summary: summaryOf(0) });
    t.emit({ type: 'library.resumed', libraryId: 'l1' });
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: true });
    expect(t.raised).toEqual([]);
  });

  it('raises scan.aborted and recovers on the library next scan.finished', () => {
    const t = setup();
    t.emit({ type: 'scan.aborted', libraryId: 'l1', message: 'ffprobe vanished' });
    expect(t.raised[0]).toMatchObject({
      event: 'scan.aborted',
      scope: 'l1',
      reason: 'ffprobe vanished',
    });
    t.emit({ type: 'scan.finished', libraryId: 'l2', summary: summaryOf(0) });
    expect(t.names()).toEqual(['scan.aborted']);
    t.emit({ type: 'scan.finished', libraryId: 'l1', summary: summaryOf(0) });
    expect(t.names()).toEqual(['scan.aborted', 'scan.aborted.recovered']);
  });
});

describe('daemon alerts: pauses', () => {
  it('ignores an operator pause, alerts a flow-invalid one', () => {
    const t = setup();
    t.emit({ type: 'library.paused', libraryId: 'l1', reason: 'operator: maintenance' });
    expect(t.raised).toEqual([]);
    t.emit({ type: 'library.resumed', libraryId: 'l1' });
    expect(t.raised).toEqual([]);

    t.emit({ type: 'library.paused', libraryId: 'l1', reason: 'flow-invalid: no flow attached' });
    expect(t.names()).toEqual(['library.paused']);
    t.emit({ type: 'library.resumed', libraryId: 'l1' });
    expect(t.names()).toEqual(['library.paused', 'library.paused.recovered']);
  });
});

describe('daemon alerts: nodes', () => {
  it('raises node.offline only after the grace, and recovers when it returns', () => {
    const t = setup();
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: false });
    t.alerts.reraise();
    expect(t.raised).toEqual([]);
    t.advance(5 * MIN);
    t.alerts.reraise();
    expect(t.names()).toEqual(['node.offline']);
    expect(t.raised[0]?.scope).toBe('n1');
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: true });
    expect(t.names()).toEqual(['node.offline', 'node.offline.recovered']);
  });

  it('raises nothing for a node that returns inside the grace', () => {
    const t = setup();
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: false });
    t.advance(2 * MIN);
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: true });
    t.advance(10 * MIN);
    t.alerts.reraise();
    expect(t.raised).toEqual([]);
  });
});

describe('daemon alerts: reraise', () => {
  it('re-offers a standing outage each time, and stops after recovery', () => {
    const t = setup();
    t.emit({ type: 'scan.finished', libraryId: 'l1', summary: summaryOf(1) });
    t.alerts.reraise();
    t.alerts.reraise();
    expect(t.names()).toEqual(Array(3).fill('library.root_missing'));
    t.emit({ type: 'scan.finished', libraryId: 'l1', summary: summaryOf(0) });
    t.alerts.reraise();
    expect(t.names()).toHaveLength(4);
    expect(t.names()[3]).toBe('library.root_missing.recovered');
  });
});

describe('daemon alerts: startup and robustness', () => {
  it('holds a boot-time outage until the startup delay, then raises it once on reraise', () => {
    const t = setup({ startupDelayMs: 2 * MIN });
    t.emit({ type: 'hardware.check_failed', findings: ['nvenc (hevc_nvenc)'] });
    t.emit({ type: 'library.paused', libraryId: 'l1', reason: 'flow-invalid: x' });
    t.alerts.reraise();
    expect(t.raised).toEqual([]);
    t.advance(2 * MIN);
    t.alerts.reraise();
    expect(t.names().sort()).toEqual(['hardware.check_failed', 'library.paused']);
  });

  it('stays silent, with no recovery, for an outage that cleared inside the startup delay', () => {
    const t = setup({ startupDelayMs: 2 * MIN });
    t.emit({ type: 'library.paused', libraryId: 'l1', reason: 'flow-invalid: x' });
    t.emit({ type: 'library.resumed', libraryId: 'l1' });
    t.advance(5 * MIN);
    t.alerts.reraise();
    expect(t.raised).toEqual([]);
  });

  it('does not let a throwing service.raise escape the bus emit', () => {
    const t = setup({
      raise: () => {
        throw new Error('service down');
      },
    });
    expect(() => {
      t.emit(finished('failed'));
    }).not.toThrow();
    expect(() => {
      t.emit({ type: 'scan.finished', libraryId: 'l1', summary: summaryOf(1) });
    }).not.toThrow();
    expect(() => {
      t.alerts.reraise();
    }).not.toThrow();
  });

  it('stops listening and forgets everything on unsubscribe', () => {
    const t = setup();
    t.emit({ type: 'scan.finished', libraryId: 'l1', summary: summaryOf(1) });
    t.alerts.unsubscribe();
    t.emit(finished('failed'));
    t.alerts.reraise();
    expect(t.names()).toEqual(['library.root_missing']);
  });

  it('subscribeDaemonAlerts returns a plain unsubscribe', () => {
    const bus = createEventBus();
    const raised: AlertInput[] = [];
    const stop = subscribeDaemonAlerts({
      bus,
      service: { raise: (i) => raised.push(i) },
      describe: { library: () => undefined, node: () => undefined, file: () => undefined },
      nowMs: () => 0,
      startupDelayMs: 0,
    });
    bus.emit(finished('failed'));
    stop();
    bus.emit(finished('failed'));
    expect(raised).toHaveLength(1);
  });
});
