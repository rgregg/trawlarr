import { describe, expect, it } from 'vitest';
import { describeFlowVersion, pluginLabel, toStepRows } from './job-detail-model.js';

describe('describeFlowVersion', () => {
  it('links a hash that was recorded', () => {
    expect(describeFlowVersion({ hash: '17dce8bd5e34', versionId: 'v9' })).toEqual({
      text: '17dce8bd',
      to: '/flows/versions/v9',
    });
  });

  it('says a hash predating versioning was never recorded, and links nowhere', () => {
    expect(describeFlowVersion({ hash: 'c49b5f39aaaa', versionId: null })).toEqual({
      text: 'c49b5f39 — this version was not recorded',
      to: null,
    });
  });
});

describe('pluginLabel', () => {
  it('reads a plugin id as words', () => {
    expect(pluginLabel('trawlarr:verifyOutput')).toBe('Verify Output');
    expect(pluginLabel('tdarr:ffmpegCommandSetContainer')).toBe('Ffmpeg Command Set Container');
  });

  it('leaves an id it cannot parse alone', () => {
    expect(pluginLabel('weird')).toBe('weird');
  });

  it('treats a second colon as another word separator, not part of the name', () => {
    expect(pluginLabel('a:b:c')).toBe('B C');
  });

  it('falls back to the whole id when nothing follows the colon', () => {
    // A trailing colon leaves an empty remainder — there is nothing here to
    // read as words, and blanking the label would be worse than showing
    // the raw id.
    expect(pluginLabel('a:')).toBe('a:');
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

  // This is the REAL empty case, not the `null` above. `repo.getSteps`
  // returns only persisted, completed steps, so a still-running step never
  // reaches this array at all — `null` in `ApiStep` is a defensive type
  // allowance, never what the daemon actually sends. What it DOES send for
  // a step whose plugin never called `jobLog` is `''` (`log_excerpt TEXT
  // NOT NULL DEFAULT ''`), and that is the common case for most non-Execute
  // steps. A test built only on `null`, like the one above, would pass
  // while every one of those steps rendered an empty reason box in
  // production — which is what happened here the first time around.
  it('treats an empty log excerpt as no reason, not a blank box', () => {
    const rows = toStepRows([
      {
        seq: 4,
        pluginId: 'trawlarr:verifyOutput',
        outputNumber: 1,
        durationMs: 12,
        logExcerpt: '',
      },
    ]);
    expect(rows[0]!.reason).toBeNull();
  });
});
