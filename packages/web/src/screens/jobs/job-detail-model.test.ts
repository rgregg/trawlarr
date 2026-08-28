import { describe, expect, it } from 'vitest';
import { pluginLabel, toStepRows } from './job-detail-model.js';

describe('pluginLabel', () => {
  it('reads a plugin id as words', () => {
    expect(pluginLabel('trawlarr:verifyOutput')).toBe('Verify Output');
    expect(pluginLabel('tdarr:ffmpegCommandSetContainer')).toBe('Ffmpeg Command Set Container');
  });

  it('leaves an id it cannot parse alone', () => {
    expect(pluginLabel('weird')).toBe('weird');
  });
});

describe('toStepRows', () => {
  it('keeps the engine reason whole — it is the reason anyone opened this', () => {
    const reason =
      'Running ffmpeg: 1 stream(s) were removed by the flow; output position 1 would carry input stream 2';
    const rows = toStepRows([
      {
        seq: 1,
        pluginId: 'trawlarr:execute',
        outputNumber: 1,
        durationMs: 107_000,
        logExcerpt: reason,
      },
    ]);
    expect(rows[0]!.reason).toBe(reason);
    expect(rows[0]!.label).toBe('Execute');
    expect(rows[0]!.outcome).toBe('ok');
  });

  it('marks output 2 as the failure it is', () => {
    const rows = toStepRows([
      {
        seq: 2,
        pluginId: 'trawlarr:verifyOutput',
        outputNumber: 2,
        durationMs: 31,
        logExcerpt: "the output's container runs 3231.5s against the original's 3232.7s",
      },
    ]);
    expect(rows[0]!.outcome).toBe('failed');
  });

  it('treats a step with no output number yet as still running', () => {
    const rows = toStepRows([
      { seq: 3, pluginId: 'trawlarr:execute', outputNumber: null, durationMs: 0, logExcerpt: null },
    ]);
    expect(rows[0]!.outcome).toBe('running');
    expect(rows[0]!.reason).toBeNull();
  });
});
