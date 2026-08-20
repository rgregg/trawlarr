import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createSettingsRepo } from '../db/settings-repo.js';
import { applyEnvSettings, envProvenance } from './env-settings.js';

const repo = () => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  return createSettingsRepo({ db });
};

describe('applyEnvSettings', () => {
  it('seeds a setting that has never been written', () => {
    const settings = repo();
    const applications = applyEnvSettings({
      settings,
      env: { NUMBER_OF_WORKERS: '4', SCHEDULE_FULL_SCAN_MINUTES: '30', TZ: 'America/Los_Angeles' },
    });

    expect(settings.getSchedule().baseCounts.transcode).toBe(4);
    expect(settings.getSchedule().timezone).toBe('America/Los_Angeles');
    expect(settings.getScan().rescanIntervalMs).toBe(1_800_000);
    expect(applications.map((a) => a.applied)).toEqual(['seeded', 'seeded', 'seeded']);
  });

  it('does NOT overwrite a setting an operator has already changed', () => {
    const settings = repo();
    settings.setSchedule({ ...settings.getSchedule(), baseCounts: { transcode: 2, health: 0 } });

    const applications = applyEnvSettings({ settings, env: { NUMBER_OF_WORKERS: '6' } });

    // The whole point: a compose file does not silently revert a UI change.
    expect(settings.getSchedule().baseCounts.transcode).toBe(2);
    expect(applications[0]!.applied).toBe('ignored-already-set');
  });

  it('reports the divergence rather than hiding it', () => {
    const settings = repo();
    settings.setSchedule({ ...settings.getSchedule(), baseCounts: { transcode: 2, health: 0 } });
    const env = { NUMBER_OF_WORKERS: '6' };
    const applications = applyEnvSettings({ settings, env });

    const provenance = envProvenance({ settings, env, applications });
    expect(provenance).toEqual([
      {
        name: 'NUMBER_OF_WORKERS',
        target: 'schedule.baseCounts.transcode',
        envValue: '6',
        applied: 'ignored-already-set',
        problem: null,
        currentValue: '2',
        matchesEnv: false,
      },
    ]);
  });

  it('records a bad value as invalid and changes nothing', () => {
    const settings = repo();
    const applications = applyEnvSettings({ settings, env: { NUMBER_OF_WORKERS: 'lots' } });

    expect(settings.getSchedule().baseCounts.transcode).toBe(1);
    expect(applications[0]!.applied).toBe('invalid');
    expect(applications[0]!.problem).not.toBeNull();
  });

  it('seeds hardware availability and caps together', () => {
    const settings = repo();
    applyEnvSettings({
      settings,
      env: { TRAWLARR_HARDWARE: 'cpu,nvenc', TRAWLARR_HARDWARE_CAPS: 'nvenc=2' },
    });
    expect(settings.getHardware()).toEqual({ available: ['cpu', 'nvenc'], caps: { nvenc: 2 } });
  });

  it('seeds scanOnStart from RUN_FULL_SCAN_ON_START', () => {
    const settings = repo();
    expect(settings.getScan().scanOnStart).toBe(true);
    applyEnvSettings({ settings, env: { RUN_FULL_SCAN_ON_START: 'false' } });
    expect(settings.getScan().scanOnStart).toBe(false);
  });
});
