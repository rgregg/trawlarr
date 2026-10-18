import { describe, expect, it } from 'vitest';
import type { ScanSummary } from '../scanner/scan-library.js';
import { createEventBus, type TrawlarrEvent } from '../daemon/events.js';
import {
  createDaemonAlerts,
  subscribeDaemonAlerts,
  type DaemonAlertsOptions,
} from './daemon-alerts.js';
import type { AlertInput } from './alert-service.js';

const MIN = 60_000;

const summaryOf = (rootsUnavailable: number): ScanSummary =>
  ({ rootsUnavailable }) as unknown as ScanSummary;

const setup = (
  options: {
    startupDelayMs?: number;
    nodeOfflineGraceMs?: number;
    raise?: (i: AlertInput) => void;
    initial?: DaemonAlertsOptions['initial'];
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
    initial: options.initial,
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

describe('daemon alerts: conditions standing at boot', () => {
  const initial = () => ({
    pausedLibraries: [
      { id: 'l1', reason: 'flow-invalid: no flow' },
      { id: 'l2', reason: 'operator: maintenance' },
    ],
    offlineNodes: [{ id: 'n1' }],
  });

  it('alerts a pre-paused library and a never-reconnecting node once, after the delay; not an operator pause', () => {
    const t = setup({ startupDelayMs: 2 * MIN, initial });
    t.alerts.reraise();
    expect(t.raised).toEqual([]);
    t.advance(2 * MIN);
    t.alerts.reraise();
    expect(t.names()).toEqual(['library.paused']); // node still inside its offline grace
    t.advance(3 * MIN);
    t.alerts.reraise();
    expect(t.names().filter((n) => n === 'node.offline')).toHaveLength(1);
    expect(t.raised.find((r) => r.event === 'library.paused')?.scope).toBe('l1');
  });

  it('does not duplicate when the bus also reports the same condition', () => {
    const t = setup({ startupDelayMs: 0, initial });
    t.emit({ type: 'library.paused', libraryId: 'l1', reason: 'flow-invalid: no flow' });
    expect(t.names()).toEqual(['library.paused']);
    t.emit({ type: 'library.paused', libraryId: 'l1', reason: 'flow-invalid: no flow' });
    expect(t.names()).toEqual(['library.paused']);
  });

  it('survives a throwing provider', () => {
    expect(() =>
      setup({
        initial: () => {
          throw new Error('db closed');
        },
      }),
    ).not.toThrow();
  });
});

describe('daemon alerts: refused nodes', () => {
  const refuse = (t: ReturnType<typeof setup>, nodeId: string | null) =>
    t.emit({
      type: 'node.refused',
      nodeId,
      reason: 'credentials were refused',
      authenticated: false,
    });
  const mismatch = (t: ReturnType<typeof setup>, nodeId: string) =>
    t.emit({
      type: 'node.refused',
      nodeId,
      reason: 'protocol version mismatch',
      authenticated: true,
    });

  it('does not alert on a single refusal, alerts on the third inside the window, once', () => {
    const t = setup();
    refuse(t, 'n1');
    refuse(t, 'n1');
    t.alerts.reraise();
    expect(t.raised).toEqual([]);
    for (let i = 0; i < 50; i++) refuse(t, 'n1');
    expect(t.raised).toHaveLength(1);
    expect(t.raised[0]).toMatchObject({
      event: 'node.offline',
      scope: 'refused:n1',
      reason: 'credentials were refused',
    });
    expect(t.raised[0]?.summary).toContain('Node n1');
  });

  it('does not count refusals spread wider than the window', () => {
    const t = setup();
    refuse(t, 'n1');
    t.advance(6 * MIN);
    refuse(t, 'n1');
    t.advance(6 * MIN);
    refuse(t, 'n1');
    expect(t.raised).toEqual([]);
  });

  it('recovers only when the node authenticates, and only if an alert went out', () => {
    const t = setup();
    refuse(t, 'n1');
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: true });
    expect(t.raised).toEqual([]);
    for (let i = 0; i < 3; i++) refuse(t, 'n1');
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: true });
    expect(t.names()).toEqual(['node.offline', 'node.offline.recovered']);
    expect(t.raised[1]?.scope).toBe('refused:n1');
  });

  it('collapses forged ids into one constant scope that stops repeating when probes stop', () => {
    const t = setup();
    for (let i = 0; i < 20; i++) refuse(t, null);
    expect(new Set(t.raised.map((r) => r.scope))).toEqual(new Set(['refused:unknown']));
    const before = t.raised.length;
    t.advance(3 * 60 * MIN);
    t.alerts.reraise();
    t.alerts.reraise();
    expect(t.raised).toHaveLength(before);
  });

  it('stops re-offering a known node refusal once refusals stop', () => {
    const t = setup();
    for (let i = 0; i < 3; i++) refuse(t, 'n1');
    t.alerts.reraise();
    const before = t.raised.length;
    t.advance(11 * MIN);
    t.alerts.reraise();
    expect(t.raised).toHaveLength(before);
  });

  it('a refusal followed by that connection detaching raises no offline alert and keeps its summary', () => {
    const t = setup();
    for (let i = 0; i < 3; i++) refuse(t, 'n1');
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: false });
    t.alerts.reraise();
    expect(t.raised).toHaveLength(2);
    expect(t.raised.every((r) => r.scope === 'refused:n1')).toBe(true);
    expect(t.raised.every((r) => r.summary.includes('was refused'))).toBe(true);
  });

  it('alerts at once on one authenticated protocol-mismatch refusal, and recovers when it connects', () => {
    const t = setup();
    mismatch(t, 'n1');
    expect(t.raised).toHaveLength(1);
    expect(t.raised[0]).toMatchObject({
      event: 'node.offline',
      scope: 'refused:n1',
      reason: 'protocol version mismatch',
    });
    expect(t.raised[0]?.summary).toContain('protocol version mismatch');
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: true });
    expect(t.names()).toEqual(['node.offline', 'node.offline.recovered']);
  });

  it('a mismatch refusal then detach, past the grace, raises no offline-for-N-minutes alert on its scope', () => {
    const t = setup();
    mismatch(t, 'n1');
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: false });
    t.advance(10 * MIN);
    t.alerts.reraise();
    const onRefusedScope = t.raised.filter((r) => r.scope === 'refused:n1');
    expect(onRefusedScope.every((r) => r.summary.includes('was refused'))).toBe(true);
    expect(onRefusedScope.some((r) => r.summary.includes('offline for'))).toBe(false);
  });

  it('keeps the threshold and a bounded history under 10,000 rapid unauthenticated refusals', () => {
    const t = setup();
    for (let i = 0; i < 10_000; i++) refuse(t, 'n1');
    expect(t.raised).toHaveLength(1);
    t.advance(11 * MIN);
    t.alerts.reraise();
    refuse(t, 'n1');
    refuse(t, 'n1');
    expect(t.raised).toHaveLength(1);
  });
});

describe('daemon alerts: display labels', () => {
  // Follow-ups are written from the label, so it must be the NAME and never the id.
  it('labels every raise with the library or node name', () => {
    const t = setup({ nodeOfflineGraceMs: 0 });
    t.emit(finished('failed'));
    t.emit({ type: 'scan.finished', libraryId: 'l2', summary: summaryOf(1) });
    t.emit({ type: 'scan.aborted', libraryId: 'l3', message: 'threw' });
    t.emit({ type: 'library.paused', libraryId: 'l4', reason: 'flow invalid' });
    t.emit({ type: 'nodes.changed', nodeId: 'n1', online: false });
    t.emit({ type: 'node.refused', nodeId: 'n2', reason: 'mismatch', authenticated: true });
    t.emit({ type: 'node.refused', nodeId: null, reason: 'bad', authenticated: false });
    expect(t.raised.map((r) => [r.event, r.label])).toEqual([
      ['file.failed', 'Lib l1'],
      ['library.root_missing', 'Lib l2'],
      ['scan.aborted', 'Lib l3'],
      ['library.paused', 'Lib l4'],
      ['node.offline', 'Node n1'],
      ['node.offline', 'Node n2'],
      ['node.offline', 'Unknown node'],
    ]);
  });

  it('gives no label, rather than the id, for a library or node that is gone', () => {
    const t = setup({ nodeOfflineGraceMs: 0 });
    t.emit({ type: 'scan.aborted', libraryId: 'gone', message: 'threw' });
    t.emit({ type: 'nodes.changed', nodeId: 'gone', online: false });
    expect(t.raised.map((r) => r.label)).toEqual([undefined, undefined]);
  });
});
