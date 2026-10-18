import { describe, expect, it } from 'vitest';
import { createEventBus, type TrawlarrEvent } from '../daemon/events.js';
import { newDestination } from '../db/settings-repo.js';
import type { ScanSummary } from '../scanner/scan-library.js';
import { createAlertService } from './alert-service.js';
import { createDaemonAlerts } from './daemon-alerts.js';
import type { Deliverer } from './deliver.js';

/**
 * What a receiver actually sees, end to end through the real coalescer, the real service and
 * the real daemon-event mapping, on a clock the test drives. Unit tests of each piece passed
 * while the whole sent "3f2b…: library.root_missing still ongoing, 60 more" to a phone, and a
 * revoked node alerted hourly until restart.
 */

const MIN = 60_000;
const LIBRARY_ID = '3f2b8c1e-9d4a-4e2b-a7c6-0b1d2e3f4a5b';
const NODE_ID = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const scan = (rootsUnavailable: number): TrawlarrEvent => ({
  type: 'scan.finished',
  libraryId: LIBRARY_ID,
  summary: { rootsUnavailable } as unknown as ScanSummary,
});

const world = () => {
  let now = Date.parse('2026-10-17T02:00:00Z');
  const sent: Array<Record<string, unknown>> = [];
  const deliverer: Deliverer = {
    enqueue: (_target, body) => sent.push(body as Record<string, unknown>),
    sendNow: () => Promise.reject(new Error('not used')),
    drain: () => Promise.resolve({ dropped: 0 }),
    lastResult: () => undefined,
    stop: () => undefined,
  };
  const service = createAlertService({
    settings: {
      getAlerts: () => ({
        publicBaseUrl: '',
        destinations: [newDestination('phone', 'https://hooks.example/t')],
      }),
    },
    deliverer,
    extraSecrets: () => [],
    nowMs: () => now,
    log: () => {},
  });
  const bus = createEventBus();
  const alerts = createDaemonAlerts({
    bus,
    service,
    describe: {
      library: (id) => (id === LIBRARY_ID ? 'Movies' : undefined),
      node: (id) => (id === NODE_ID ? 'gpu-box' : undefined),
      file: () => undefined,
    },
    nowMs: () => now,
    startupDelayMs: 0,
  });
  return {
    sent,
    emit: (event: TrawlarrEvent) => bus.emit(event),
    /** Advance minute by minute, running the daemon's alert tick as it does. */
    runFor: (ms: number, each?: (at: number) => void) => {
      const end = now + ms;
      while (now < end) {
        now += MIN;
        each?.(now);
        service.tick();
        alerts.reraise();
      }
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('alert scenarios', () => {
  it('A: a library root missing for three hours is one alert, hourly reminders, one recovery', () => {
    const w = world();
    w.emit(scan(1));
    // The periodic rescan keeps finding it gone, on top of the daemon's minute-by-minute re-offers.
    let minute = 0;
    w.runFor(3 * 60 * MIN - 2 * MIN, () => {
      minute += 1;
      if (minute % 60 === 0) w.emit(scan(1));
    });
    w.emit(scan(0));
    w.runFor(60 * MIN);

    expect(w.sent.map((b) => [b.event, b.summary])).toEqual([
      ['library.root_missing', 'Movies: 1 root(s) cannot be reached, so nothing was reconciled.'],
      ['library.root_missing', 'Movies: roots still unreachable'],
      ['library.root_missing', 'Movies: roots still unreachable'],
      ['library.root_missing.recovered', 'Movies: its roots are reachable again.'],
    ]);
    for (const body of w.sent) expect(JSON.stringify(body)).not.toMatch(UUID);
  });

  it('C: a revoked node is silent from the revoke on, offline or refused', () => {
    const w = world();
    // Offline long enough to have alerted before the operator acts.
    w.emit({ type: 'nodes.changed', nodeId: NODE_ID, online: false });
    w.runFor(10 * MIN);
    expect(w.sent.map((b) => b.event)).toEqual(['node.offline']);
    const before = w.sent.length;

    // The revoke route: the disconnect's offline event, then the removal.
    w.emit({ type: 'nodes.changed', nodeId: NODE_ID, online: false });
    w.emit({ type: 'node.removed', nodeId: NODE_ID });
    // The revoked node keeps retrying every 30 s. The hub reports none of those 401s; even if a
    // refusal reached the bus, it must not raise anything for a removed node.
    w.runFor(3 * 60 * MIN, () => {
      w.emit({
        type: 'node.refused',
        nodeId: NODE_ID,
        reason: 'credentials were refused',
        authenticated: false,
      });
    });

    expect(w.sent).toHaveLength(before);
  });
});
