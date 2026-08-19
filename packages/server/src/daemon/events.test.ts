import { describe, expect, it } from 'vitest';
import { createEventBus, type TrawlarrEvent } from './events.js';

const progress = (jobId: string, percent: number): TrawlarrEvent => ({
  type: 'job.progress',
  jobId,
  percent,
  stage: 'transcode',
});

describe('the event bus', () => {
  it('delivers every event to every subscriber', () => {
    const bus = createEventBus();
    const first: TrawlarrEvent[] = [];
    const second: TrawlarrEvent[] = [];
    bus.subscribe((event) => first.push(event));
    bus.subscribe((event) => second.push(event));

    // Asymmetric on purpose: two events with different values, so a bus that
    // delivered the wrong one (or the same one twice) cannot pass.
    bus.emit(progress('job-1', 10));
    bus.emit(progress('job-2', 20));

    expect(first.map((event) => (event.type === 'job.progress' ? event.percent : null))).toEqual([
      10, 20,
    ]);
    expect(second).toEqual(first);
  });

  it('stops delivering after unsubscribe, and only to the listener that unsubscribed', () => {
    const bus = createEventBus();
    const staying: TrawlarrEvent[] = [];
    const leaving: TrawlarrEvent[] = [];
    bus.subscribe((event) => staying.push(event));
    const unsubscribe = bus.subscribe((event) => leaving.push(event));

    bus.emit(progress('job-1', 10));
    unsubscribe();
    unsubscribe(); // idempotent: a second call must not disturb anyone else
    bus.emit(progress('job-2', 20));
    bus.emit(progress('job-3', 30));

    expect(staying).toHaveLength(3);
    expect(leaving).toHaveLength(1);
  });

  it('isolates a listener that throws, so the emitting job survives it', () => {
    const bus = createEventBus();
    const after: TrawlarrEvent[] = [];
    bus.subscribe(() => {
      throw new Error('an API client serialisation bug');
    });
    bus.subscribe((event) => after.push(event));

    expect(() => bus.emit(progress('job-1', 10))).not.toThrow();
    expect(after).toHaveLength(1);
  });

  it('delivers against a snapshot: subscribing during an emit affects the NEXT event only', () => {
    const bus = createEventBus();
    const late: TrawlarrEvent[] = [];
    let subscribed = false;
    bus.subscribe(() => {
      if (subscribed) return;
      subscribed = true;
      bus.subscribe((event) => late.push(event));
    });

    bus.emit(progress('job-1', 10));
    expect(late).toHaveLength(0);
    bus.emit(progress('job-2', 20));
    expect(late).toHaveLength(1);
  });

  it('does not call a listener that unsubscribed during the same emit', () => {
    const bus = createEventBus();
    const received: TrawlarrEvent[] = [];
    // Registered FIRST so it runs before the listener it removes.
    let removeSecond = () => {};
    bus.subscribe(() => {
      removeSecond();
    });
    removeSecond = bus.subscribe((event) => received.push(event));

    bus.emit(progress('job-1', 10));
    expect(received).toHaveLength(0);
  });
});
