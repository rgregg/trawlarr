import { HARDWARE_TYPES, type HardwareType } from '@trawlarr/core';
import type { SettingsRepo } from '../db/settings-repo.js';

export interface EnvBinding {
  name: string;
  /** The dotted setting this seeds, or the CLI option it defaults. */
  target: string;
  describe: string;
}

export interface EnvApplication {
  name: string;
  target: string;
  envValue: string;
  applied: 'seeded' | 'ignored-already-set' | 'invalid';
  problem: string | null;
}

interface SeedBinding extends EnvBinding {
  /** The `setting` row that decides whether this has already been written. */
  settingKey: string;
  apply: (settings: SettingsRepo, raw: string) => void;
  read: (settings: SettingsRepo) => string;
}

const parseWholeNumber = (raw: string, label: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a whole number of 0 or more, got ${JSON.stringify(raw)}.`);
  }
  return value;
};

const parseBoolean = (raw: string, label: string): boolean => {
  const lowered = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
  if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  throw new Error(`${label} must be true or false, got ${JSON.stringify(raw)}.`);
};

const parseHardwareList = (raw: string): HardwareType[] =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      if (!(HARDWARE_TYPES as readonly string[]).includes(entry)) {
        throw new Error(
          `TRAWLARR_HARDWARE lists "${entry}", which is not a hardware type. Valid: ` +
            `${HARDWARE_TYPES.join(', ')}.`,
        );
      }
      return entry as HardwareType;
    });

const parseHardwareCaps = (raw: string): Partial<Record<HardwareType, number>> => {
  const caps: Partial<Record<HardwareType, number>> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const [key, value] = trimmed.split('=');
    if (key === undefined || value === undefined) {
      throw new Error(
        `TRAWLARR_HARDWARE_CAPS entries look like "nvenc=2", got ${JSON.stringify(trimmed)}.`,
      );
    }
    if (!(HARDWARE_TYPES as readonly string[]).includes(key)) {
      throw new Error(
        `TRAWLARR_HARDWARE_CAPS names "${key}", which is not a hardware type. Valid: ` +
          `${HARDWARE_TYPES.join(', ')}.`,
      );
    }
    caps[key as HardwareType] = parseWholeNumber(value, `TRAWLARR_HARDWARE_CAPS.${key}`);
  }
  return caps;
};

const SEEDS: SeedBinding[] = [
  {
    name: 'TZ',
    target: 'schedule.timezone',
    settingKey: 'schedule.timezone',
    describe:
      'The timezone schedule windows are evaluated in. Deliberately a stored setting rather ' +
      'than the host clock, so a container with TZ unset does not shift every window.',
    apply: (settings, raw) => {
      settings.setSchedule({ ...settings.getSchedule(), timezone: raw });
    },
    read: (settings) => settings.getSchedule().timezone,
  },
  {
    name: 'NUMBER_OF_WORKERS',
    target: 'schedule.baseCounts.transcode',
    settingKey: 'schedule.baseCounts',
    describe: 'How many transcode workers run when no schedule window says otherwise.',
    apply: (settings, raw) => {
      const schedule = settings.getSchedule();
      settings.setSchedule({
        ...schedule,
        baseCounts: {
          ...schedule.baseCounts,
          transcode: parseWholeNumber(raw, 'NUMBER_OF_WORKERS'),
        },
      });
    },
    read: (settings) => String(settings.getSchedule().baseCounts.transcode),
  },
  {
    name: 'SCHEDULE_FULL_SCAN_MINUTES',
    target: 'scan.rescanIntervalMs',
    settingKey: 'scan.rescanIntervalMs',
    describe:
      'Minutes between periodic full rescans. This is the correctness backstop for network ' +
      'mounts, where filesystem watch events are dropped.',
    apply: (settings, raw) => {
      settings.setScan({
        rescanIntervalMs: parseWholeNumber(raw, 'SCHEDULE_FULL_SCAN_MINUTES') * 60_000,
      });
    },
    read: (settings) => String(settings.getScan().rescanIntervalMs / 60_000),
  },
  {
    name: 'RUN_FULL_SCAN_ON_START',
    target: 'scan.scanOnStart',
    settingKey: 'scan.scanOnStart',
    describe: 'Whether every enabled library is walked when the daemon starts.',
    apply: (settings, raw) => {
      settings.setScan({ scanOnStart: parseBoolean(raw, 'RUN_FULL_SCAN_ON_START') });
    },
    read: (settings) => String(settings.getScan().scanOnStart),
  },
  {
    name: 'TRAWLARR_API_KEY',
    target: 'daemon.apiKey',
    settingKey: 'daemon.apiKey',
    describe:
      'The API key clients send as X-Api-Key. Set it in compose to know it in advance; leave ' +
      'it unset and one is generated and printed on the first run only.',
    apply: (settings, raw) => {
      if (raw.length < 16) {
        throw new Error(
          `TRAWLARR_API_KEY must be at least 16 characters. A short key is the whole of this ` +
            `API's authentication.`,
        );
      }
      settings.setDaemon({ apiKey: raw });
    },
    // Never returned to a caller — see envProvenance's redaction.
    read: (settings) => settings.getDaemon().apiKey,
  },
  {
    name: 'TRAWLARR_HARDWARE',
    target: 'hardware.available',
    settingKey: 'hardware.available',
    describe:
      'Which hardware this node DECLARES it has, comma-separated (e.g. "cpu,nvenc"). ' +
      'Trawlarr never detects hardware; declaring nvenc on a machine without it produces ' +
      'failing jobs.',
    apply: (settings, raw) => {
      settings.setHardware({ available: parseHardwareList(raw) });
    },
    read: (settings) => settings.getHardware().available.join(','),
  },
  {
    name: 'TRAWLARR_HARDWARE_CAPS',
    target: 'hardware.caps',
    settingKey: 'hardware.caps',
    describe:
      'Concurrency cap per hardware type, e.g. "nvenc=2" for a consumer NVIDIA card whose ' +
      'NVENC session limit fails jobs rather than queueing them.',
    apply: (settings, raw) => {
      settings.setHardware({ caps: parseHardwareCaps(raw) });
    },
    read: (settings) =>
      Object.entries(settings.getHardware().caps)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(','),
  },
];

/** Per-run overrides. Documented here so the reference is one table, not two. */
const OVERRIDES: EnvBinding[] = [
  {
    name: 'TRAWLARR_PORT',
    target: 'daemon.port (this run only)',
    describe: 'Same meaning as "trawlarr daemon --port". Not stored.',
  },
  {
    name: 'TRAWLARR_BIND',
    target: 'daemon.bind (this run only)',
    describe: 'Same meaning as "trawlarr daemon --bind". Not stored.',
  },
  {
    name: 'TRAWLARR_DATA_DIR',
    target: '--data-dir (this run only)',
    describe: 'Default for every command’s --data-dir. Not stored.',
  },
];

export const ENV_BINDINGS: readonly EnvBinding[] = [
  ...SEEDS.map(({ name, target, describe }) => ({ name, target, describe })),
  ...OVERRIDES,
];

/**
 * Seed settings from the environment.
 *
 * SEEDING, NOT OVERRIDING, and the asymmetry is the decision: an operator who
 * changes a value in the UI and finds it reverted on the next restart cannot
 * trust the UI, while an operator whose compose file quietly does nothing
 * cannot trust the compose file. Seeding satisfies the first; `envProvenance`
 * — surfaced on GET /system/settings and in the UI — satisfies the second, by
 * saying out loud that the variable was read and did not win.
 *
 * An invalid value is RECORDED AND SKIPPED rather than thrown: refusing to
 * start a media server because one optional variable is misspelt trades a
 * cosmetic problem for a total outage.
 */
export const applyEnvSettings = (input: {
  settings: SettingsRepo;
  env: NodeJS.ProcessEnv;
}): EnvApplication[] => {
  const applications: EnvApplication[] = [];
  // "Already set" is decided from a snapshot taken before any seed runs, not
  // re-checked as we go: setSchedule/setHardware persist every sibling field
  // of their group (timezone, baseCounts and windows all get written when
  // only timezone changes), so seeding TZ would otherwise mark
  // schedule.baseCounts as "written" and silently block NUMBER_OF_WORKERS
  // from seeding a brand-new install, purely because of SEEDS ordering.
  const alreadySet = new Map(
    SEEDS.map((seed) => [seed.name, input.settings.isSet(seed.settingKey)] as const),
  );
  for (const seed of SEEDS) {
    const envValue = input.env[seed.name];
    if (envValue === undefined || envValue === '') continue;

    if (alreadySet.get(seed.name)) {
      applications.push({
        name: seed.name,
        target: seed.target,
        envValue,
        applied: 'ignored-already-set',
        problem: null,
      });
      continue;
    }
    try {
      seed.apply(input.settings, envValue);
      applications.push({
        name: seed.name,
        target: seed.target,
        envValue,
        applied: 'seeded',
        problem: null,
      });
    } catch (error) {
      applications.push({
        name: seed.name,
        target: seed.target,
        envValue,
        applied: 'invalid',
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return applications;
};

const REDACTED = '(redacted)';

/**
 * What each environment variable did, and whether the live value still agrees
 * with it. `matchesEnv: false` is the sentence a UI puts in front of an
 * operator: the compose file says one thing and the running system another.
 */
export const envProvenance = (input: {
  settings: SettingsRepo;
  env: NodeJS.ProcessEnv;
  applications: EnvApplication[];
}): Array<EnvApplication & { currentValue: string; matchesEnv: boolean }> =>
  input.applications.map((application) => {
    const seed = SEEDS.find((candidate) => candidate.name === application.name)!;
    const secret = seed.settingKey === 'daemon.apiKey';
    const current = seed.read(input.settings);
    return {
      ...application,
      envValue: secret ? REDACTED : application.envValue,
      currentValue: secret ? REDACTED : current,
      matchesEnv: current === application.envValue,
    };
  });
