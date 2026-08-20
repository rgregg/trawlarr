import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * POSIX only, decided SYNCHRONOUSLY at module scope: `describe.runIf` is
 * evaluated at collection time, so a condition set by an async `beforeAll`
 * silently skips every run. A POSIX host without /bin/bash is an ERROR, not
 * a skip — "the tool is missing" and "we could not check" must not look the
 * same.
 */
const POSIX = process.platform !== 'win32';
if (POSIX) statSync('/bin/bash');

/** A stub that records its own argv, one line per invocation, and succeeds. */
const stub = (dir: string, name: string, log: string): void => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\nexit 0\n`);
  chmodSync(path, 0o755);
};

describe.runIf(POSIX)('docker/entrypoint.sh', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-entrypoint-'));
    const bin = join(root, 'bin');
    const data = join(root, 'config');
    mkdirSync(bin);
    const log = join(root, 'calls.log');
    for (const name of ['usermod', 'groupmod', 'chown', 'gosu']) stub(bin, name, log);
    return { root, bin, data, log };
  };

  it('aligns the service user to PUID/PGID and execs the command', async () => {
    const { bin, data, log } = setup();

    await run('bash', ['docker/entrypoint.sh', 'trawlarr', 'daemon'], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        PUID: '1234',
        PGID: '5678',
        TRAWLARR_DATA_DIR: data,
      },
    });

    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toContain('groupmod -o -g 5678 trawlarr');
    expect(calls).toContain('usermod -o -u 1234 -g 5678 trawlarr');
    expect(calls).toContain(`chown -R 1234:5678 ${data}`);
    // The exec'd argv is the whole point: the entrypoint must hand the
    // container's command through unchanged, or CMD overrides stop working.
    expect(calls.at(-1)).toBe('gosu trawlarr:trawlarr trawlarr daemon');
  });

  it('defaults PUID and PGID to 1000 and creates the data directory', async () => {
    const { bin, data, log } = setup();

    await run('bash', ['docker/entrypoint.sh', 'trawlarr', 'daemon'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, TRAWLARR_DATA_DIR: data },
    });

    expect(statSync(data).isDirectory()).toBe(true);
    expect(statSync(join(data, 'logs', 'jobs')).isDirectory()).toBe(true);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('usermod -o -u 1000 -g 1000 trawlarr');
  });

  it('writes /etc/localtime and /etc/timezone when TZ is set', async () => {
    const { root, bin, data } = setup();
    const etc = join(root, 'etc');
    mkdirSync(join(root, 'zoneinfo', 'America'), { recursive: true });
    writeFileSync(join(root, 'zoneinfo', 'America', 'Los_Angeles'), 'TZif-stub');
    mkdirSync(etc);

    await run('bash', ['docker/entrypoint.sh', 'trawlarr', 'daemon'], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        TRAWLARR_DATA_DIR: data,
        TZ: 'America/Los_Angeles',
        TRAWLARR_ETC_DIR: etc,
        TRAWLARR_ZONEINFO_DIR: join(root, 'zoneinfo'),
      },
    });

    expect(readFileSync(join(etc, 'timezone'), 'utf8').trim()).toBe('America/Los_Angeles');
    expect(readFileSync(join(etc, 'localtime'), 'utf8')).toBe('TZif-stub');
  });

  it('refuses an unknown TZ by name rather than silently running in UTC', async () => {
    const { root, bin, data } = setup();
    mkdirSync(join(root, 'zoneinfo'), { recursive: true });
    mkdirSync(join(root, 'etc'));

    await expect(
      run('bash', ['docker/entrypoint.sh', 'trawlarr', 'daemon'], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          TRAWLARR_DATA_DIR: data,
          TZ: 'Mars/Olympus_Mons',
          TRAWLARR_ETC_DIR: join(root, 'etc'),
          TRAWLARR_ZONEINFO_DIR: join(root, 'zoneinfo'),
        },
      }),
    ).rejects.toMatchObject({ code: 78 });
  });
});
