import { describe, expect, it } from 'vitest';
import type { FlowMessageStatus } from '../alerts/alert-service.js';
import { createJobAlertRelay, MAX_ALERTS_PER_JOB } from './alert-relay.js';

const setup = (status: FlowMessageStatus | (() => never) = 'queued') => {
  const raised: unknown[] = [];
  const lines: string[] = [];
  const relay = createJobAlertRelay({
    job: { jobId: 'job-1', path: '/lib/a.mkv', libraryName: 'Movies' },
    raise: (request) => {
      raised.push(request);
      if (typeof status === 'function') return status();
      return status;
    },
  });
  return { relay, raised, lines, log: (text: string) => lines.push(text) };
};

describe('createJobAlertRelay', () => {
  it("raises with the job's own library, path and id and the plugin's destination and message", () => {
    const { relay, raised, lines, log } = setup();
    relay({ destination: 'ha', message: 'hi' }, log);
    expect(raised).toEqual([
      { destination: 'ha', message: 'hi', library: 'Movies', path: '/lib/a.mkv', jobId: 'job-1' },
    ]);
    expect(lines).toEqual([]);
  });

  it('leaves off whatever the job does not know, rather than sending undefined', () => {
    const raised: unknown[] = [];
    const relay = createJobAlertRelay({
      job: { jobId: 'job-1' },
      raise: (request) => {
        raised.push(request);
        return 'queued';
      },
    });
    relay({ destination: 'ha', message: 'hi' }, () => {});
    expect(raised).toEqual([{ destination: 'ha', message: 'hi', jobId: 'job-1' }]);
    expect(Object.keys(raised[0] as object)).not.toContain('library');
  });

  it('ignores library, path and jobId smuggled onto the request', () => {
    const { relay, raised, log } = setup();
    relay(
      {
        destination: 'ha',
        message: 'hi',
        library: 'X',
        path: '/etc/passwd',
        jobId: 'other',
      } as never,
      log,
    );
    expect(raised).toEqual([
      { destination: 'ha', message: 'hi', library: 'Movies', path: '/lib/a.mkv', jobId: 'job-1' },
    ]);
  });

  it.each([
    ['unknown', 'Alert not sent: destination "ha" is unknown'],
    ['disabled', 'Alert not sent: destination "ha" is disabled'],
    ['error', 'Alert not sent: destination "ha" could not be queued'],
  ] as const)('writes one job-log line for %s', (status, line) => {
    const { relay, lines, log } = setup(status);
    relay({ destination: 'ha', message: 'hi' }, log);
    expect(lines).toEqual([line]);
    expect(lines.join('')).not.toMatch(/https?:|header/i);
  });

  it.each(['queued', 'stopped'] as const)('writes nothing for %s', (status) => {
    const { relay, lines, log } = setup(status);
    relay({ destination: 'ha', message: 'hi' }, log);
    expect(lines).toEqual([]);
  });

  it('ignores the 101st request with exactly one log line', () => {
    const { relay, raised, lines, log } = setup();
    for (let i = 0; i < MAX_ALERTS_PER_JOB + 5; i += 1) {
      relay({ destination: 'ha', message: String(i) }, log);
    }
    expect(raised).toHaveLength(MAX_ALERTS_PER_JOB);
    expect(lines).toEqual(['Alert limit reached for this job']);
  });

  it('never throws, whether raise or the log sink does', () => {
    const throwing = setup(() => {
      throw new Error('boom https://secret.example/hook');
    });
    expect(() => {
      throwing.relay({ destination: 'ha', message: 'x' }, throwing.log);
    }).not.toThrow();
    const sinkThrows = setup('unknown');
    expect(() => {
      sinkThrows.relay({ destination: 'ha', message: 'x' }, () => {
        throw new Error('disk');
      });
    }).not.toThrow();
  });
});
