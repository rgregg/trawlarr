import { describe, expect, it } from 'vitest';
import { ALERT_EVENT_TYPES, createCoalescer, normalizeCause } from './alerts.js';

const MIN = 60_000;
const opts = { windowMs: 15 * MIN, maxCausesPerWindow: 10, repeatMs: 60 * MIN };

describe('normalizeCause', () => {
  it('maps reasons differing only in path and attempt count to one string', () => {
    expect(normalizeCause('ffmpeg exited 1 at /library/a/b.mkv (attempt 3)')).toBe(
      normalizeCause('ffmpeg exited 1 at /library/c/d.mkv (attempt 2)'),
    );
  });
  it('keeps reasons that differ in words apart', () => {
    expect(normalizeCause('ffmpeg exited 1')).not.toBe(normalizeCause('disk full'));
  });
  it('strips quoted names and collapses whitespace and case', () => {
    expect(normalizeCause('Cannot   open "My Movie.mkv"')).toBe(
      normalizeCause("cannot open 'Other.mkv'"),
    );
  });
});

describe('createCoalescer', () => {
  it('sends the first offer and counts the rest into one summary', () => {
    const c = createCoalescer(opts);
    const k = { event: 'file.failed' as const, scope: 'lib1', cause: 'boom' };
    expect(c.offer({ ...k, nowMs: 0 })).toEqual({ send: true });
    for (let i = 0; i < 2000; i++) {
      expect(c.offer({ ...k, example: `/m/${i}.mkv`, nowMs: 1000 + i })).toEqual({ send: false });
    }
    expect(c.due(opts.windowMs - 1)).toEqual([]);
    const out = c.due(opts.windowMs + 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'summary', count: 2000, otherCauses: 0 });
    expect(out[0]!.examples.length).toBeLessThanOrEqual(3);
    expect(c.due(opts.windowMs * 3)).toEqual([]);
  });

  it('sends the first ten causes and folds the rest into otherCauses', () => {
    const c = createCoalescer(opts);
    const sent = [];
    for (let i = 0; i < 12; i++) {
      sent.push(
        c.offer({ event: 'file.failed', scope: 'lib1', cause: `cause ${i}`, nowMs: i }).send,
      );
    }
    expect(sent.filter(Boolean)).toHaveLength(10);
    const out = c.due(opts.windowMs + 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'summary', otherCauses: 2 });
  });

  it('repeats a standing outage no more often than repeatMs', () => {
    const c = createCoalescer(opts);
    let sends = 0;
    let followUps = 0;
    for (let m = 0; m < 180; m++) {
      const now = m * MIN;
      if (c.offer({ event: 'node.offline', scope: 'n1', cause: 'offline', nowMs: now }).send)
        sends++;
      for (const f of c.due(now)) {
        followUps++;
        expect(['summary', 'still-down']).toContain(f.kind);
      }
    }
    expect(sends).toBe(1);
    expect(followUps).toBeLessThanOrEqual(3);
    expect(followUps).toBeGreaterThanOrEqual(2);
  });

  it('stops repeating once the condition is no longer offered', () => {
    const c = createCoalescer(opts);
    c.offer({ event: 'node.offline', scope: 'n1', cause: 'offline', nowMs: 0 });
    expect(c.due(10 * 60 * MIN)).toEqual([]);
  });

  it('clear resets the key so the next offer sends at once', () => {
    const c = createCoalescer(opts);
    const k = { event: 'library.root_missing' as const, scope: 'lib1', cause: 'gone' };
    c.offer({ ...k, nowMs: 0 });
    expect(c.offer({ ...k, nowMs: 1 }).send).toBe(false);
    c.clear('library.root_missing', 'lib1');
    expect(c.offer({ ...k, nowMs: 2 }).send).toBe(true);
    expect(c.due(opts.windowMs * 4)).toEqual([]);
  });

  it('never coalesces flow messages, tests or recovered events', () => {
    const c = createCoalescer(opts);
    for (const event of ['flow.message', 'test', 'node.offline.recovered'] as const) {
      expect(c.offer({ event, scope: 's', cause: 'x', nowMs: 0 }).send).toBe(true);
      expect(c.offer({ event, scope: 's', cause: 'x', nowMs: 1 }).send).toBe(true);
    }
  });

  it('lists the seven daemon event types', () => {
    expect(ALERT_EVENT_TYPES).toHaveLength(7);
  });

  it('applies the cause cap per window on a long-running outage, not for its lifetime', () => {
    const c = createCoalescer(opts);
    for (let i = 0; i < 10; i++) {
      expect(
        c.offer({ event: 'library.root_missing', scope: 'lib1', cause: `cause ${i}`, nowMs: i })
          .send,
      ).toBe(true);
    }
    expect(
      c.offer({ event: 'library.root_missing', scope: 'lib1', cause: 'cause 10', nowMs: 20 }).send,
    ).toBe(false);
    c.due(opts.windowMs + 1);
    // Window rolled over: an unrelated new cause must not stay hidden for the outage's lifetime.
    expect(
      c.offer({
        event: 'library.root_missing',
        scope: 'lib1',
        cause: 'cause 10',
        nowMs: opts.windowMs + 2,
      }).send,
    ).toBe(true);
    // A still-down emission is also a rollover.
    const e = 'library.root_missing' as const;
    let t = opts.windowMs + 3;
    let stillDown = 0;
    while (stillDown === 0) {
      c.offer({ event: e, scope: 'lib1', cause: 'cause 0', nowMs: t });
      stillDown = c.due(t).filter((f) => f.kind === 'still-down').length;
      t += MIN;
    }
    const sent = [];
    for (let i = 20; i < 31; i++)
      sent.push(c.offer({ event: e, scope: 'lib1', cause: `cause ${i}`, nowMs: t }).send);
    expect(sent.filter(Boolean)).toHaveLength(10);
  });
});
