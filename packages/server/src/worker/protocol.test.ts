import { describe, expect, it } from 'vitest';
import { parseAgentMessage } from './protocol.js';

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
