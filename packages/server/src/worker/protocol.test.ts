import { describe, expect, it } from 'vitest';
import {
  MAX_ALERT_DESTINATION_CHARS,
  MAX_ALERT_MESSAGE_CHARS,
  parseAgentMessage,
  parseDaemonMessage,
} from './protocol.js';

describe('review hold wire fields', () => {
  it.each([
    {},
    { held: false, reviewReason: null },
    { held: true, reviewReason: 'Inspect quality.' },
  ])('preserves optional JSON review metadata %j', (fields) => {
    const message = { type: 'done', report: { jobId: 'job-1', ...fields } };
    expect(parseAgentMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it.each([{ held: 'yes' }, { held: null }, { reviewReason: 42 }, { reviewReason: {} }])(
    'rejects malformed hold fields %j',
    (fields) => {
      expect(parseAgentMessage({ type: 'done', report: fields })).toBeNull();
    },
  );
});

describe('protocol v2: commit round trip and superseded failures', () => {
  it('parses commit-request and rejects an unknown kind', () => {
    expect(
      parseAgentMessage({
        type: 'commit-request',
        id: 1,
        kind: 'replace',
        pluginId: 'trawlarr:replaceOriginal',
      }),
    ).toEqual({
      type: 'commit-request',
      id: 1,
      kind: 'replace',
      pluginId: 'trawlarr:replaceOriginal',
    });
    expect(
      parseAgentMessage({ type: 'commit-request', id: 1, kind: 'delete', pluginId: 'x' }),
    ).toBeNull();
  });

  it('parses commit-result both ways', () => {
    expect(
      parseDaemonMessage({ type: 'commit-result', id: 3, granted: false, reason: 'no' }),
    ).toEqual({
      type: 'commit-result',
      id: 3,
      granted: false,
      reason: 'no',
    });
    expect(
      parseDaemonMessage({ type: 'commit-result', id: 3, granted: 'yes', reason: null }),
    ).toBeNull();
  });

  it('carries superseded on failed', () => {
    expect(parseAgentMessage({ type: 'failed', error: 'x', superseded: true })).toEqual({
      type: 'failed',
      error: 'x',
      superseded: true,
    });
    expect(parseAgentMessage({ type: 'failed', error: 'x', superseded: 'y' })).toBeNull();
  });

  it('every new message survives a JSON round trip unchanged', () => {
    const messages = [
      { type: 'commit-request', id: 1, kind: 'plugin', pluginId: 'a' },
      { type: 'failed', error: 'e', superseded: true },
    ];
    for (const message of messages) {
      expect(parseAgentMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
  });
});

describe('alert-request', () => {
  it('accepts a destination and a message, and survives a JSON round trip', () => {
    const message = { type: 'alert-request', destination: 'ha', message: 'x' };
    expect(parseAgentMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it.each([
    { destination: 'ha' },
    { message: 'x' },
    { destination: 1, message: 'x' },
    { destination: 'ha', message: { text: 'x' } },
    { destination: null, message: 'x' },
  ])('rejects missing or non-string fields %j', (fields) => {
    expect(parseAgentMessage({ type: 'alert-request', ...fields })).toBeNull();
  });

  it('rejects an oversized destination rather than clipping it to a different name', () => {
    const destination = 'd'.repeat(MAX_ALERT_DESTINATION_CHARS + 1);
    expect(parseAgentMessage({ type: 'alert-request', destination, message: 'x' })).toBeNull();
    const edge = 'd'.repeat(MAX_ALERT_DESTINATION_CHARS);
    expect(
      parseAgentMessage({ type: 'alert-request', destination: edge, message: 'x' }),
    ).not.toBeNull();
  });

  it('truncates an oversized message', () => {
    const parsed = parseAgentMessage({
      type: 'alert-request',
      destination: 'ha',
      message: 'm'.repeat(MAX_ALERT_MESSAGE_CHARS + 500),
    });
    expect(parsed).toEqual({
      type: 'alert-request',
      destination: 'ha',
      message: 'm'.repeat(MAX_ALERT_MESSAGE_CHARS),
    });
  });

  it('drops any extra field a plugin attaches, so library, path and jobId cannot be spoofed', () => {
    const parsed = parseAgentMessage({
      type: 'alert-request',
      destination: 'ha',
      message: 'x',
      library: 'Other',
      path: '/etc/passwd',
      jobId: 'someone-else',
    });
    expect(parsed).toEqual({ type: 'alert-request', destination: 'ha', message: 'x' });
  });

  it('still drops an unrecognised message type', () => {
    expect(
      parseAgentMessage({ type: 'alert-requests', destination: 'ha', message: 'x' }),
    ).toBeNull();
  });
});
