import { ALERT_EVENT_TYPES } from '@trawlarr/core';
import { describe, expect, it } from 'vitest';
import {
  EVENT_LABELS,
  MASK,
  describeResult,
  formFromResource,
  toPutBody,
  validateAlerts,
  validateDestination,
  type AlertsResource,
} from './alerts-model.js';
import { ALERT_EVENTS } from './alerts-model.js';

const SECRET_URL = 'https://hooks.example.com/services/T000/B000/s3cr3t-token';
const SECRET_HEADER = 'Bearer s3cr3t-header-value';

const resource = (): AlertsResource => ({
  publicBaseUrl: 'https://trawlarr.lan',
  destinations: [
    {
      name: 'ops',
      enabled: true,
      events: Object.fromEntries(ALERT_EVENTS.map((e) => [e, true])) as Record<string, boolean>,
      url: `https://hooks.example.com/${MASK}`,
      headers: [{ name: 'Authorization', value: MASK }],
    },
  ],
});

describe('alert event vocabulary', () => {
  it('mirrors core, so a new event type cannot be silently unconfigurable here', () => {
    expect([...ALERT_EVENTS]).toEqual([...ALERT_EVENT_TYPES]);
    for (const e of ALERT_EVENTS) expect(EVENT_LABELS[e].length).toBeGreaterThan(0);
  });
});

describe('toPutBody', () => {
  it('sends an untouched masked secret back exactly as received', () => {
    const loaded = resource();
    const body = toPutBody(formFromResource(loaded), loaded);
    expect(body.destinations[0]?.url).toBe(`https://hooks.example.com/${MASK}`);
    expect(body.destinations[0]?.headers).toEqual([{ name: 'Authorization', value: MASK }]);
    expect(body.publicBaseUrl).toBe('https://trawlarr.lan');
  });

  it('sends an edited url and header value as the new value', () => {
    const loaded = resource();
    const form = formFromResource(loaded);
    form.destinations[0]!.url = SECRET_URL;
    form.destinations[0]!.headers[0]!.value = SECRET_HEADER;
    const body = toPutBody(form, loaded);
    expect(body.destinations[0]?.url).toBe(SECRET_URL);
    expect(body.destinations[0]?.headers[0]?.value).toBe(SECRET_HEADER);
  });

  it('never sends the read-only last result', () => {
    const loaded = resource();
    loaded.destinations[0]!.lastResult = { ok: true, status: 200, error: null, atMs: 1 };
    const body = toPutBody(formFromResource(loaded), loaded);
    expect(Object.keys(body.destinations[0] ?? {}).sort()).toEqual([
      'enabled',
      'events',
      'headers',
      'name',
      'url',
    ]);
  });
});

describe('validateAlerts', () => {
  it('accepts the loaded state untouched', () => {
    const loaded = resource();
    expect(validateAlerts(formFromResource(loaded), loaded)).toBeNull();
  });

  it('requires a renamed destination to get a fresh url, because the server keeps secrets by name', () => {
    const loaded = resource();
    const form = formFromResource(loaded);
    form.destinations[0]!.name = 'ops2';
    const message = validateAlerts(form, loaded);
    expect(message).toMatch(/ops2/);
    expect(message).toMatch(/url/i);
    form.destinations[0]!.url = SECRET_URL;
    expect(validateAlerts(form, loaded)).toMatch(/header/i);
    form.destinations[0]!.headers[0]!.value = SECRET_HEADER;
    expect(validateAlerts(form, loaded)).toBeNull();
  });

  it('requires a new destination to be typed fresh', () => {
    const loaded = resource();
    const form = formFromResource(loaded);
    form.destinations.push({
      key: 'n1',
      name: 'new',
      enabled: true,
      events: {},
      url: '',
      headers: [],
    });
    expect(validateAlerts(form, loaded)).toMatch(/url/i);
  });

  it('requires headers to be re-entered when the url is replaced', () => {
    const loaded = resource();
    const form = formFromResource(loaded);
    form.destinations[0]!.url = SECRET_URL;
    expect(validateAlerts(form, loaded)).toMatch(/header/i);
  });

  it('compares names trimmed, as they are sent', () => {
    const loaded = resource();
    const form = formFromResource(loaded);
    form.destinations.push({ ...form.destinations[0]!, key: 'dup', name: 'ops ' });
    expect(validateAlerts(form, loaded)).toMatch(/unique/i);
    // A padded name still finds the stored destination, so its masked url is kept.
    const padded = formFromResource(loaded);
    padded.destinations[0]!.name = ' ops';
    expect(validateAlerts(padded, loaded)).toBeNull();
  });

  it('refuses duplicate names', () => {
    const loaded = resource();
    const form = formFromResource(loaded);
    form.destinations.push({ ...form.destinations[0]!, key: 'dup' });
    expect(validateAlerts(form, loaded)).toMatch(/unique|already/i);
  });
});

describe('validateDestination', () => {
  const base = () => ({
    key: 'k',
    name: 'ops',
    enabled: true,
    events: {},
    url: SECRET_URL,
    headers: [{ key: 'h', name: 'Authorization', value: SECRET_HEADER }],
  });

  it('accepts a good destination', () => {
    expect(validateDestination(base())).toBeNull();
  });
  it('refuses an empty name', () => {
    expect(validateDestination({ ...base(), name: '  ' })).toMatch(/name/i);
  });
  it('refuses a non-http url', () => {
    expect(validateDestination({ ...base(), url: 'ftp://example.com/x' })).toMatch(/http/i);
    expect(validateDestination({ ...base(), url: 'not a url' })).toMatch(/http/i);
  });
  it('refuses empty and non-token header names', () => {
    expect(
      validateDestination({ ...base(), headers: [{ key: 'h', name: '', value: 'v' }] }),
    ).toMatch(/header/i);
    expect(
      validateDestination({ ...base(), headers: [{ key: 'h', name: 'Bad Name:', value: 'v' }] }),
    ).toMatch(/header/i);
  });
  it('never puts a url or header value in a message', () => {
    const bad = [
      { ...base(), url: 'ftp://hooks.example.com/s3cr3t-token' },
      { ...base(), headers: [{ key: 'h', name: 'Bad Name', value: SECRET_HEADER }] },
      { ...base(), name: '' },
    ];
    for (const d of bad) {
      const message = validateDestination(d) ?? '';
      expect(message).not.toContain('s3cr3t');
    }
    const loaded = resource();
    const form = formFromResource(loaded);
    form.destinations[0]!.name = 'renamed';
    form.destinations[0]!.url = SECRET_URL;
    form.destinations[0]!.headers[0]!.value = MASK;
    expect(validateAlerts(form, loaded) ?? '').not.toContain('s3cr3t');
  });
});

describe('describeResult', () => {
  it('describes success, HTTP failure and classed errors in one short line', () => {
    expect(describeResult({ ok: true, status: 200, error: null })).toBe('200 OK');
    expect(describeResult({ ok: false, status: 503, error: 'HTTP 503' })).toBe('HTTP 503');
    expect(describeResult({ ok: false, status: null, error: 'timeout' })).toBe('timeout');
    expect(describeResult({ ok: false, status: 404, error: null })).toBe('HTTP 404');
    expect(describeResult({ ok: false, status: null, error: null })).toBe('failed');
  });
});
