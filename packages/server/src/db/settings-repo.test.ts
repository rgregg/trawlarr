import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';
import {
  createSettingsRepo,
  knownSecrets,
  MIN_LEASE_GRACE_MS,
  minLeaseGraceMs,
  newDestination,
  SettingValidationError,
} from './settings-repo.js';

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
      notifyPathMap: [],
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

  it('generates a session secret once and then keeps returning the same one', () => {
    const db = freshDb();
    let calls = 0;
    const repo = createSettingsRepo({
      db,
      generateSessionSecret: () => {
        calls += 1;
        return `secret-${calls}`;
      },
    });
    expect(repo.getAuth().sessionSecret).toBe('secret-1');
    expect(repo.getAuth().sessionSecret).toBe('secret-1');
    expect(calls).toBe(1);
    expect(createSettingsRepo({ db }).getAuth().sessionSecret).toBe('secret-1');
  });

  it('defaults OIDC to disabled and empty', () => {
    const repo = createSettingsRepo({ db: freshDb() });
    expect(repo.getAuth()).toMatchObject({
      oidcEnabled: false,
      oidcIssuer: '',
      oidcClientId: '',
      oidcClientSecret: '',
      oidcRedirectUri: '',
    });
  });

  it('refuses to enable OIDC without every required field', () => {
    const repo = createSettingsRepo({ db: freshDb() });
    expect(() => repo.setAuth({ oidcEnabled: true })).toThrow(SettingValidationError);
    expect(() =>
      repo.setAuth({
        oidcEnabled: true,
        oidcIssuer: 'https://auth.example.com',
        oidcClientId: 'client',
        oidcClientSecret: 'secret',
        oidcRedirectUri: 'https://trawlarr.example.com/api/v1/auth/oidc/callback',
      }),
    ).not.toThrow();
  });

  it('nodes settings default to a one-hour lease grace and validate the floor', () => {
    const repo = createSettingsRepo({ db: freshDb() });
    expect(repo.getNodes()).toEqual({ leaseGraceMs: 3_600_000 });
    expect(() => repo.setNodes({ leaseGraceMs: 299_999 })).toThrow(SettingValidationError);
    repo.setNodes({ leaseGraceMs: 300_000 });
    expect(repo.getNodes()).toEqual({ leaseGraceMs: 300_000 });
  });

  it('lowers the lease grace floor only for a test process that explicitly asks', () => {
    // The end-to-end seam must never reach production: the variable alone,
    // or NODE_ENV=test alone, keeps the five-minute floor.
    expect(minLeaseGraceMs({ TRAWLARR_TEST_ALLOW_SHORT_GRACE: '1' })).toBe(MIN_LEASE_GRACE_MS);
    expect(minLeaseGraceMs({ NODE_ENV: 'production', TRAWLARR_TEST_ALLOW_SHORT_GRACE: '1' })).toBe(
      MIN_LEASE_GRACE_MS,
    );
    expect(minLeaseGraceMs({ NODE_ENV: 'test' })).toBe(MIN_LEASE_GRACE_MS);
    expect(minLeaseGraceMs({ NODE_ENV: 'test', TRAWLARR_TEST_ALLOW_SHORT_GRACE: '1' })).toBe(1);
  });

  describe('alerts', () => {
    it('defaults to no destinations and round-trips a saved one', () => {
      const repo = createSettingsRepo({ db: freshDb() });
      expect(repo.getAlerts()).toEqual({ publicBaseUrl: '', destinations: [] });
      const next = {
        publicBaseUrl: 'https://trawlarr.example',
        destinations: [
          {
            ...newDestination('ops', 'https://hooks.example/x'),
            headers: [{ name: 'Authorization', value: 'Bearer s3cret' }],
          },
        ],
      };
      repo.setAlerts(next);
      expect(repo.getAlerts()).toEqual(next);
    });

    it('builds a new destination with every event and the destination enabled', () => {
      const dest = newDestination('ops', 'http://hooks.example/x');
      expect(dest.enabled).toBe(true);
      expect(dest.headers).toEqual([]);
      expect(Object.keys(dest.events).length).toBeGreaterThan(0);
      expect(Object.values(dest.events).every((on) => on === true)).toBe(true);
    });

    it('rejects a duplicate name, an empty name, a non-http(s) url and an unknown event key', () => {
      const repo = createSettingsRepo({ db: freshDb() });
      const set = (destinations: unknown[], publicBaseUrl = ''): void =>
        repo.setAlerts({ publicBaseUrl, destinations } as never);
      const ok = newDestination('a', 'https://a.example');
      expect(() => set([ok, newDestination('a', 'https://b.example')])).toThrow(
        SettingValidationError,
      );
      expect(() => set([newDestination('  ', 'https://a.example')])).toThrow(
        SettingValidationError,
      );
      expect(() => set([newDestination('a', 'ftp://x')])).toThrow(SettingValidationError);
      expect(() => set([newDestination('a', 'javascript:1')])).toThrow(SettingValidationError);
      expect(() => set([{ ...ok, events: { ...ok.events, bogus: true } }])).toThrow(
        SettingValidationError,
      );
      expect(repo.getAlerts().destinations).toEqual([]);
    });

    // The node and every reference trim the name, so a saved " ops" could never be reached.
    it('rejects a name with leading or trailing whitespace on write, without echoing a secret', () => {
      const repo = createSettingsRepo({ db: freshDb() });
      for (const name of [' ops', 'ops ', '\tops']) {
        let message = '';
        try {
          repo.setAlerts({
            publicBaseUrl: '',
            destinations: [newDestination(name, 'https://hooks.example/tok-456')],
          });
        } catch (error) {
          expect(error).toBeInstanceOf(SettingValidationError);
          message = (error as Error).message;
        }
        expect(message).toMatch(/space/);
        expect(message).not.toContain('tok-456');
      }
      expect(repo.getAlerts().destinations).toEqual([]);
    });

    it('writes the base url and the destinations together or not at all', () => {
      const db = freshDb();
      const repo = createSettingsRepo({ db });
      db.exec(
        `CREATE TRIGGER no_destinations BEFORE INSERT ON setting
         WHEN NEW.key = 'alerts.destinations' BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
      );
      expect(() =>
        repo.setAlerts({
          publicBaseUrl: 'https://trawlarr.example',
          destinations: [newDestination('ops', 'https://hooks.example/x')],
        }),
      ).toThrow();
      expect(repo.getAlerts().publicBaseUrl).toBe('');
    });

    it('accepts an empty public base url and rejects a non-http(s) one', () => {
      const repo = createSettingsRepo({ db: freshDb() });
      repo.setAlerts({ publicBaseUrl: '', destinations: [] });
      repo.setAlerts({ publicBaseUrl: 'http://nas.lan:8265', destinations: [] });
      expect(() => repo.setAlerts({ publicBaseUrl: 'ftp://x', destinations: [] })).toThrow(
        SettingValidationError,
      );
    });

    describe('stored destinations and headers', () => {
      const store = (db: ReturnType<typeof freshDb>, destinations: unknown): void => {
        db.prepare(`INSERT INTO setting (key, value) VALUES (?, ?)`).run(
          'alerts.destinations',
          JSON.stringify(destinations),
        );
      };

      it('reads a stored destination missing an event type as on', () => {
        const db = freshDb();
        const dest = newDestination('a', 'https://a.example');
        const [first, ...rest] = Object.keys(dest.events);
        const events: Record<string, boolean> = { ...dest.events };
        events[first as string] = false;
        for (const key of rest.slice(0, 1)) delete events[key];
        store(db, [{ ...dest, events }]);
        const read = createSettingsRepo({ db }).getAlerts().destinations[0];
        expect(read?.events[first as keyof typeof dest.events]).toBe(false);
        expect(Object.values(read?.events ?? {}).length).toBe(Object.keys(dest.events).length);
        if (rest[0] !== undefined) {
          expect(read?.events[rest[0] as keyof typeof dest.events]).toBe(true);
        }
      });

      it('still throws on read for a wrong-typed or unknown event key', () => {
        const dest = newDestination('a', 'https://a.example');
        const first = Object.keys(dest.events)[0] as string;
        const wrong = freshDb();
        store(wrong, [{ ...dest, events: { ...dest.events, [first]: 'yes' } }]);
        expect(() => createSettingsRepo({ db: wrong }).getAlerts()).toThrow(SettingValidationError);
        const unknown = freshDb();
        store(unknown, [{ ...dest, events: { ...dest.events, bogus: true } }]);
        expect(() => createSettingsRepo({ db: unknown }).getAlerts()).toThrow(
          SettingValidationError,
        );
      });

      it('rejects a missing event key on write', () => {
        const repo = createSettingsRepo({ db: freshDb() });
        const dest = newDestination('a', 'https://a.example');
        const events: Record<string, boolean> = { ...dest.events };
        delete events[Object.keys(events)[0] as string];
        expect(() =>
          repo.setAlerts({ publicBaseUrl: '', destinations: [{ ...dest, events } as never] }),
        ).toThrow(SettingValidationError);
      });

      it.each([
        ['a name with a space', { name: 'X Bad', value: 'v-secret-1' }, 'v-secret-1'],
        ['a name with a colon', { name: 'X:Bad', value: 'v-secret-2' }, 'v-secret-2'],
        ['a value with CRLF', { name: 'X-Ok', value: 'abc\r\nX-Evil: 1' }, 'X-Evil'],
        ['a value with NUL', { name: 'X-Ok', value: 'abc\0def' }, 'abc'],
      ])('rejects %s without echoing the value', (_label, header, leak) => {
        const repo = createSettingsRepo({ db: freshDb() });
        const dest = { ...newDestination('a', 'https://a.example/tok-123'), headers: [header] };
        let message = '';
        try {
          repo.setAlerts({ publicBaseUrl: '', destinations: [dest] });
        } catch (error) {
          expect(error).toBeInstanceOf(SettingValidationError);
          message = (error as Error).message;
        }
        expect(message).not.toBe('');
        expect(message).not.toContain(leak);
        expect(message).not.toContain('tok-123');
        expect(repo.getAlerts().destinations).toEqual([]);
      });
    });

    it('lists every destination url and non-empty header value as a secret, and nothing else', () => {
      const dest = {
        ...newDestination('ops', 'https://hooks.example/token'),
        headers: [
          { name: 'Authorization', value: 'Bearer s3cret' },
          { name: 'X-Empty', value: '' },
        ],
      };
      expect(knownSecrets({ publicBaseUrl: 'https://t.example', destinations: [dest] })).toEqual([
        'https://hooks.example/token',
        'Bearer s3cret',
      ]);
    });
  });
});
