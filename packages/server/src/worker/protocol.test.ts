import { describe, expect, it } from 'vitest';
import { parseAgentMessage, parseDaemonMessage } from './protocol.js';

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
