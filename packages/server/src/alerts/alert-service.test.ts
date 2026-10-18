import { describe, expect, it } from 'vitest';
import { newDestination, type AlertSettings } from '../db/settings-repo.js';
import { createAlertService } from './alert-service.js';
import type { Deliverer, DeliveryResult, DeliveryTarget } from './deliver.js';

type Body = Record<string, unknown>;

const harness = (initial: Partial<AlertSettings> = {}) => {
  let settings: AlertSettings = {
    publicBaseUrl: '',
    destinations: [newDestination('hook', 'https://hooks.example/secret-token')],
    ...initial,
  };
  let throwSettings: Error | null = null;
  let throwEnqueue = false;
  let throwExtra = false;
  let now = Date.parse('2026-10-17T18:00:00Z');
  const sent: Array<{ target: DeliveryTarget; body: Body }> = [];
  const now_: Array<{ target: DeliveryTarget; body: Body }> = [];
  const logs: string[] = [];
  let drained = 0;
  const ok: DeliveryResult = { ok: true, status: 200, error: null, atMs: 0 };
  const deliverer: Deliverer = {
    enqueue: (target, body) => {
      if (throwEnqueue) throw new Error('boom');
      sent.push({ target, body: body as Body });
    },
    sendNow: (target, body) => {
      now_.push({ target, body: body as Body });
      return Promise.resolve(ok);
    },
    drain: () => {
      drained++;
      return Promise.resolve({ dropped: 2 });
    },
    lastResult: () => undefined,
    stop: () => undefined,
  };
  const service = createAlertService({
    settings: {
      getAlerts: () => {
        if (throwSettings) throw throwSettings;
        return settings;
      },
    },
    deliverer,
    extraSecrets: () => {
      if (throwExtra) throw new Error('no secrets');
      return ['api-key-123', ''];
    },
    nowMs: () => now,
    log: (l) => logs.push(l),
  });
  return {
    service,
    sent,
    now_,
    logs,
    ok,
    get drained() {
      return drained;
    },
    set: (s: AlertSettings) => (settings = s),
    breakSettings: (e: Error) => (throwSettings = e),
    breakEnqueue: () => (throwEnqueue = true),
    breakExtra: () => (throwExtra = true),
    advance: (ms: number) => (now += ms),
  };
};

describe('AlertService', () => {
  it('sends only to enabled destinations with the event on; recovered follows the base event', () => {
    const on = newDestination('on', 'https://a/1');
    const off = newDestination('off', 'https://a/2');
    off.events['node.offline'] = false;
    const disabled = { ...newDestination('dis', 'https://a/3'), enabled: false };
    const h = harness({ destinations: [on, off, disabled] });
    h.service.raise({ event: 'node.offline', scope: 'n1', summary: 'down' });
    h.service.raise({ event: 'node.offline.recovered', scope: 'n1', summary: 'up' });
    expect(h.sent.map((s) => [s.target.name, s.body.event])).toEqual([
      ['on', 'node.offline'],
      ['on', 'node.offline.recovered'],
    ]);
  });

  it('shapes the payload and omits absent fields', () => {
    const h = harness();
    h.service.raise({ event: 'file.failed', scope: 'Movies', summary: 's' });
    expect(h.sent[0]!.body).toEqual({
      event: 'file.failed',
      at: '2026-10-17T18:00:00.000Z',
      summary: 's',
    });
  });

  it('builds the job link from a base url with a prefix and trailing slash', () => {
    const h = harness({
      publicBaseUrl: 'https://h/trawlarr//',
      destinations: [newDestination('hook', 'https://x/y')],
    });
    h.service.raise({
      event: 'file.failed',
      scope: 'M',
      summary: 's',
      library: 'Movies',
      path: '/m/a.mkv',
      reason: 'r',
      jobId: 'j1',
    });
    expect(h.sent[0]!.body).toMatchObject({
      library: 'Movies',
      path: '/m/a.mkv',
      reason: 'r',
      url: 'https://h/trawlarr/jobs/j1',
    });
  });

  it('omits url without a base url or without a job id', () => {
    const h = harness();
    h.service.raise({ event: 'file.failed', scope: 'M', summary: 's', jobId: 'j1' });
    h.set({ publicBaseUrl: 'https://h', destinations: [newDestination('hook', 'https://x/y')] });
    h.service.raise({ event: 'file.failed', scope: 'M2', summary: 's' });
    expect(h.sent.every((s) => !('url' in s.body))).toBe(true);
  });

  it('redacts known secrets in summary, reason and path, longest first, not library', () => {
    const h = harness();
    h.service.raise({
      event: 'file.failed',
      scope: 'M',
      summary: 'posted to https://hooks.example/secret-token',
      reason: 'bad key api-key-123',
      path: '/m/api-key-123/a.mkv',
      library: 'api-key-123',
    });
    const b = h.sent[0]!.body;
    expect(b.summary).toBe('posted to [redacted]');
    expect(b.reason).toBe('bad key [redacted]');
    expect(b.path).toBe('/m/[redacted]/a.mkv');
    expect(b.library).toBe('api-key-123');
  });

  it('redacts the longer secret whole when a shorter one is its prefix', () => {
    const d = newDestination('hook', 'https://h/abc');
    d.headers = [{ name: 'X', value: 'https://h/abcdef' }];
    const h = harness({ destinations: [d] });
    h.service.raise({ event: 'file.failed', scope: 'M', summary: 'see https://h/abcdef now' });
    expect(h.sent[0]!.body.summary).toBe('see [redacted] now');
  });

  it('coalesces a flood into one send and one summary follow-up', () => {
    const h = harness();
    for (let i = 0; i < 500; i++) {
      h.service.raise({
        event: 'file.failed',
        scope: 'Movies',
        summary: `f${i} failed`,
        path: `/m/api-key-123/${i}.mkv`,
        reason: `mount gone for /m/${i}.mkv`,
      });
    }
    expect(h.sent).toHaveLength(1);
    h.advance(16 * 60_000);
    h.service.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.body).toMatchObject({ event: 'file.failed', count: 499 });
    expect(h.sent[1]!.body.examples).toEqual([
      '/m/[redacted]/1.mkv',
      '/m/[redacted]/2.mkv',
      '/m/[redacted]/3.mkv',
    ]);
    expect(typeof h.sent[1]!.body.summary).toBe('string');
    expect('otherCauses' in h.sent[1]!.body).toBe(false);
  });

  it('filters follow-ups by destination at send time', () => {
    const off = newDestination('off', 'https://a/2');
    off.events['file.failed'] = false;
    const h = harness({ destinations: [newDestination('on', 'https://a/1'), off] });
    for (let i = 0; i < 3; i++)
      h.service.raise({ event: 'file.failed', scope: 'M', summary: 's', reason: 'same' });
    h.advance(16 * 60_000);
    h.service.tick();
    expect(h.sent.map((s) => s.target.name)).toEqual(['on', 'on']);
  });

  it('a recovered event clears the coalescer so a recurrence alerts at once', () => {
    const h = harness();
    const down = { event: 'node.offline' as const, scope: 'n1', summary: 'down' };
    h.service.raise(down);
    h.service.raise(down);
    expect(h.sent).toHaveLength(1);
    h.service.raise({ event: 'node.offline.recovered', scope: 'n1', summary: 'up' });
    h.service.raise(down);
    expect(h.sent.map((s) => s.body.event)).toEqual([
      'node.offline',
      'node.offline.recovered',
      'node.offline',
    ]);
  });

  it('flow messages go only to a known enabled destination and are not coalesced', () => {
    const h = harness({
      destinations: [
        newDestination('hook', 'https://a/1'),
        { ...newDestination('dis', 'https://a/2'), enabled: false },
      ],
    });
    expect(h.service.raiseFlowMessage({ destination: 'nope', message: 'm' })).toBe('unknown');
    expect(h.service.raiseFlowMessage({ destination: 'dis', message: 'm' })).toBe('disabled');
    expect(h.sent).toHaveLength(0);
    expect(h.service.raiseFlowMessage({ destination: 'hook', message: 'm' })).toBe('queued');
    expect(h.service.raiseFlowMessage({ destination: 'hook', message: 'm' })).toBe('queued');
    expect(h.sent.map((s) => [s.target.name, s.body.event])).toEqual([
      ['hook', 'flow.message'],
      ['hook', 'flow.message'],
    ]);
    expect(h.logs.join('\n')).not.toContain('https://');
  });

  it('flow message status is error when settings or enqueue throw, stopped after stop', async () => {
    const a = harness();
    a.breakSettings(new Error('x'));
    expect(a.service.raiseFlowMessage({ destination: 'hook', message: 'm' })).toBe('error');
    const b = harness();
    b.breakEnqueue();
    expect(b.service.raiseFlowMessage({ destination: 'hook', message: 'm' })).toBe('error');
    const c = harness();
    await c.service.stop(10);
    expect(c.service.raiseFlowMessage({ destination: 'hook', message: 'm' })).toBe('stopped');
  });

  it('redacts flow message text and path', () => {
    const h = harness();
    h.service.raiseFlowMessage({
      destination: 'hook',
      message: 'key api-key-123 here',
      path: '/m/api-key-123.mkv',
    });
    expect(h.sent[0]!.body).toMatchObject({
      summary: 'key [redacted] here',
      path: '/m/[redacted].mkv',
    });
  });

  it('redacts a secret saved after the first event in the later follow-up', () => {
    const h = harness();
    const raise = (i: number): void =>
      h.service.raise({
        event: 'file.failed',
        scope: 'Movies',
        summary: 'failed',
        path: `/m/late-secret/${i}.mkv`,
        reason: 'same',
      });
    raise(0);
    raise(1);
    const d = newDestination('hook', 'https://hooks.example/secret-token');
    d.headers = [{ name: 'X', value: 'late-secret' }];
    h.set({ publicBaseUrl: '', destinations: [d] });
    h.advance(16 * 60_000);
    h.service.tick();
    expect(h.sent[1]!.body.examples).toEqual(['/m/[redacted]/1.mkv']);
  });

  it('still sends, redacting stored secrets only, when extraSecrets throws', () => {
    const h = harness();
    h.breakExtra();
    h.service.raise({
      event: 'file.failed',
      scope: 'M',
      summary: 'https://hooks.example/secret-token api-key-123',
    });
    expect(h.sent[0]!.body.summary).toBe('[redacted] api-key-123');
  });

  it('redacts the follow-up summary', () => {
    const h = harness();
    for (let i = 0; i < 2; i++)
      h.service.raise({ event: 'file.failed', scope: 'api-key-123', summary: 's', reason: 'r' });
    h.advance(16 * 60_000);
    h.service.tick();
    expect(h.sent[1]!.body.summary).toBe('[redacted]: 1 more file.failed');
  });

  it('puts the library on a follow-up when known and omits it for node events', () => {
    const h = harness();
    for (let i = 0; i < 2; i++) {
      h.service.raise({
        event: 'file.failed',
        scope: 'lib1',
        summary: 's',
        library: 'Movies',
        reason: 'r',
      });
      h.service.raise({ event: 'node.offline', scope: 'n1', summary: 's' });
    }
    h.advance(16 * 60_000);
    h.service.tick();
    const follow = h.sent.filter((s) => 'count' in s.body);
    expect(follow.find((s) => s.body.event === 'file.failed')!.body.library).toBe('Movies');
    expect('library' in follow.find((s) => s.body.event === 'node.offline')!.body).toBe(false);
  });

  it('sendTest uses sendNow regardless of toggles and returns its result', async () => {
    const d = newDestination('hook', 'https://a/1');
    for (const k of Object.keys(d.events)) d.events[k as keyof typeof d.events] = false;
    const h = harness({ destinations: [d] });
    expect(await h.service.sendTest('hook')).toBe(h.ok);
    expect(h.now_[0]!.body.event).toBe('test');
    expect(h.sent).toHaveLength(0);
    expect((await h.service.sendTest('missing')).ok).toBe(false);
  });

  it('treats a throwing getAlerts as no destinations and logs once', () => {
    const h = harness();
    h.breakSettings(new Error('corrupt section'));
    expect(() => {
      h.service.raise({ event: 'file.failed', scope: 'M', summary: 's' });
      h.service.raise({ event: 'file.failed', scope: 'M2', summary: 's' });
      h.service.raiseFlowMessage({ destination: 'hook', message: 'm' });
      h.service.tick();
    }).not.toThrow();
    expect(h.sent).toHaveLength(0);
    expect(h.logs.filter((l) => l.includes('could not read alert settings'))).toHaveLength(1);
  });

  it('never logs the message of a settings error', () => {
    const h = harness();
    h.breakSettings(new Error('bad value {"token":"distinct-secret-xyz"}'));
    h.service.raise({ event: 'file.failed', scope: 'M', summary: 's' });
    expect(h.sent).toHaveLength(0);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.join('\n')).not.toContain('distinct-secret-xyz');
  });

  it('does not propagate a throwing deliverer.enqueue', () => {
    const h = harness();
    h.breakEnqueue();
    expect(() => h.service.raise({ event: 'file.failed', scope: 'M', summary: 's' })).not.toThrow();
    expect(() => h.service.raiseFlowMessage({ destination: 'hook', message: 'm' })).not.toThrow();
  });

  it('stop drains within the deadline and makes later raises no-ops', async () => {
    const h = harness();
    expect(await h.service.stop(1000)).toEqual({ dropped: 2 });
    h.service.raise({ event: 'file.failed', scope: 'M', summary: 's' });
    h.service.raiseFlowMessage({ destination: 'hook', message: 'm' });
    h.service.tick();
    expect(h.sent).toHaveLength(0);
  });
});
