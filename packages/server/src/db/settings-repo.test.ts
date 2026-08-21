import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';
import { createSettingsRepo, SettingValidationError } from './settings-repo.js';

const freshDb = () => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  return db;
};

describe('settings repo', () => {
  it('returns documented defaults for an empty database', () => {
    const repo = createSettingsRepo({ db: freshDb() });
    const daemon = repo.getDaemon();
    expect(daemon.bind).toBe('127.0.0.1');
    expect(daemon.port).toBe(8265);
    expect(repo.getBinaries()).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    expect(repo.getScan()).toEqual({
      watchEnabled: true,
      rescanIntervalMs: 3_600_000,
      settleMs: 30_000,
      scanOnStart: true,
      probeConcurrency: 4,
    });
    expect(repo.getHardware()).toEqual({ available: ['cpu'], caps: {} });
  });

  it('rejects a probe concurrency outside the range a scan will honour', () => {
    const repo = createSettingsRepo({ db: freshDb() });
    // A performance dial is still validated: an operator who types 10000
    // wants a named error, not ten thousand ffprobe processes.
    expect(() => repo.setScan({ probeConcurrency: 0 })).toThrow(SettingValidationError);
    expect(() => repo.setScan({ probeConcurrency: 65 })).toThrow(SettingValidationError);
    repo.setScan({ probeConcurrency: 8 });
    expect(repo.getScan().probeConcurrency).toBe(8);
  });

  it('generates an api key once and then keeps returning the same one', () => {
    const db = freshDb();
    let calls = 0;
    const repo = createSettingsRepo({
      db,
      generateApiKey: () => {
        calls += 1;
        return `key-${calls}`;
      },
    });
    expect(repo.getDaemon().apiKey).toBe('key-1');
    expect(repo.getDaemon().apiKey).toBe('key-1');
    expect(calls).toBe(1);
    // Persisted, not memoised in the instance: a second repo over the same
    // database must agree, or a daemon restart would invalidate every
    // client's key.
    expect(createSettingsRepo({ db }).getDaemon().apiKey).toBe('key-1');
  });

  it('round-trips a patch without disturbing the other fields', () => {
    const repo = createSettingsRepo({ db: freshDb() });
    const key = repo.getDaemon().apiKey;
    repo.setDaemon({ port: 9000 });
    expect(repo.getDaemon()).toEqual({ bind: '127.0.0.1', port: 9000, apiKey: key });
  });

  it('rejects a stored value that is not the type the setting requires', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO setting (key, value) VALUES ('daemon.port', '"eleven"')`).run();
    expect(() => createSettingsRepo({ db }).getDaemon()).toThrow(SettingValidationError);
  });

  it('rejects a port outside the legal range on write, so it can never be stored', () => {
    const repo = createSettingsRepo({ db: freshDb() });
    expect(() => repo.setDaemon({ port: 0 })).toThrow(SettingValidationError);
    expect(() => repo.setDaemon({ port: 70_000 })).toThrow(SettingValidationError);
  });

  it('rejects a hardware cap that is negative or not a whole number', () => {
    const repo = createSettingsRepo({ db: freshDb() });
    expect(() => repo.setHardware({ caps: { nvenc: -1 } })).toThrow(SettingValidationError);
    expect(() => repo.setHardware({ caps: { nvenc: 1.5 } })).toThrow(SettingValidationError);
  });
});
