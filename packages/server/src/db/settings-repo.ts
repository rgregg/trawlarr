import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SCHEDULE,
  HARDWARE_TYPES,
  ScheduleConfigError,
  validateSchedule,
  type HardwareType,
  type ScheduleConfig,
} from '@trawlarr/core';
import type { Db } from './connection.js';

export interface DaemonSettings {
  bind: string;
  port: number;
  apiKey: string;
}

export interface BinarySettings {
  ffmpeg: string;
  ffprobe: string;
}

export interface ScanSettings {
  watchEnabled: boolean;
  rescanIntervalMs: number;
  settleMs: number;
  scanOnStart: boolean;
}

export interface HardwareSettings {
  available: HardwareType[];
  caps: Partial<Record<HardwareType, number>>;
}

export interface SettingsRepo {
  getDaemon(): DaemonSettings;
  setDaemon(patch: Partial<DaemonSettings>): void;
  getBinaries(): BinarySettings;
  setBinaries(patch: Partial<BinarySettings>): void;
  getScan(): ScanSettings;
  setScan(patch: Partial<ScanSettings>): void;
  getHardware(): HardwareSettings;
  setHardware(patch: Partial<HardwareSettings>): void;
  getSchedule(): ScheduleConfig;
  setSchedule(config: ScheduleConfig): void;
  isSet(key: string): boolean;
}

/**
 * A stored setting is validated on read, not trusted: the `setting` table is
 * a plain text column a human can edit by hand, so a port of `"eleven"` must
 * surface as a named error at startup rather than an `EADDRINUSE`-shaped
 * mystery downstream. The same validation runs on write, so a bad value can
 * never be stored in the first place.
 */
export class SettingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingValidationError';
  }
}

const SETTING_KEYS = {
  daemon: 'daemon',
  binaries: 'binaries',
  scan: 'scan',
  hardware: 'hardware',
  schedule: 'schedule',
} as const;

const DEFAULT_DAEMON: Omit<DaemonSettings, 'apiKey'> = { bind: '127.0.0.1', port: 8265 };
const DEFAULT_BINARIES: BinarySettings = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
const DEFAULT_SCAN: ScanSettings = {
  watchEnabled: true,
  rescanIntervalMs: 3_600_000,
  settleMs: 30_000,
  scanOnStart: true,
};
const DEFAULT_HARDWARE: HardwareSettings = { available: ['cpu'], caps: {} };

const requireWholeNumber = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingValidationError(
      `${label} must be a whole number between ${min} and ${max}, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new SettingValidationError(`${label} must be a string, got ${JSON.stringify(value)}.`);
  }
  return value;
};

const requireBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new SettingValidationError(`${label} must be a boolean, got ${JSON.stringify(value)}.`);
  }
  return value;
};

const HARDWARE_TYPE_SET: ReadonlySet<string> = new Set(HARDWARE_TYPES);

const validateDaemon = (value: {
  bind: unknown;
  port: unknown;
  apiKey: unknown;
}): DaemonSettings => ({
  bind: requireString(value.bind, 'daemon.bind'),
  port: requireWholeNumber(value.port, 'daemon.port', 1, 65_535),
  apiKey: requireString(value.apiKey, 'daemon.apiKey'),
});

const validateBinaries = (value: { ffmpeg: unknown; ffprobe: unknown }): BinarySettings => ({
  ffmpeg: requireString(value.ffmpeg, 'binaries.ffmpeg'),
  ffprobe: requireString(value.ffprobe, 'binaries.ffprobe'),
});

const validateScan = (value: {
  watchEnabled: unknown;
  rescanIntervalMs: unknown;
  settleMs: unknown;
  scanOnStart: unknown;
}): ScanSettings => ({
  watchEnabled: requireBoolean(value.watchEnabled, 'scan.watchEnabled'),
  rescanIntervalMs: requireWholeNumber(
    value.rescanIntervalMs,
    'scan.rescanIntervalMs',
    0,
    Number.MAX_SAFE_INTEGER,
  ),
  settleMs: requireWholeNumber(value.settleMs, 'scan.settleMs', 0, Number.MAX_SAFE_INTEGER),
  scanOnStart: requireBoolean(value.scanOnStart, 'scan.scanOnStart'),
});

const validateHardware = (value: { available: unknown; caps: unknown }): HardwareSettings => {
  if (
    !Array.isArray(value.available) ||
    value.available.some((entry) => typeof entry !== 'string' || !HARDWARE_TYPE_SET.has(entry))
  ) {
    throw new SettingValidationError(
      `hardware.available must be an array of hardware types (one of ${HARDWARE_TYPES.join(', ')}), got ${JSON.stringify(value.available)}.`,
    );
  }
  if (value.caps === null || typeof value.caps !== 'object' || Array.isArray(value.caps)) {
    throw new SettingValidationError(
      `hardware.caps must be an object, got ${JSON.stringify(value.caps)}.`,
    );
  }
  const caps: Partial<Record<HardwareType, number>> = {};
  for (const [key, capValue] of Object.entries(value.caps as Record<string, unknown>)) {
    if (!HARDWARE_TYPE_SET.has(key)) {
      throw new SettingValidationError(
        `hardware.caps has unknown hardware type "${key}"; expected one of ${HARDWARE_TYPES.join(', ')}.`,
      );
    }
    caps[key as HardwareType] = requireWholeNumber(
      capValue,
      `hardware.caps.${key}`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  return { available: value.available as HardwareType[], caps };
};

interface SettingRow {
  value: string;
}

/**
 * Each setting group is decomposed field-by-field into rows keyed
 * `<group>.<field>` (e.g. `daemon.port`, `hardware.caps`) rather than one
 * JSON blob per group. That is what lets a hand-edited single field —
 * `daemon.port` set to `"eleven"` by a human poking at the database — be
 * caught as a validation error on the next read without disturbing sibling
 * fields, and lets `setDaemon({port: 9000})` update exactly the row it
 * changed.
 */
export const createSettingsRepo = (input: {
  db: Db;
  generateApiKey?: () => string;
}): SettingsRepo => {
  const { db } = input;
  const generateApiKey = input.generateApiKey ?? (() => randomBytes(24).toString('hex'));

  const selectStmt = db.prepare(`SELECT value FROM setting WHERE key = ?`);
  const upsertStmt = db.prepare(
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const readRawKey = (key: string): unknown => {
    const row = selectStmt.get(key) as SettingRow | undefined;
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      throw new SettingValidationError(`Stored value for "${key}" is not valid JSON.`);
    }
  };

  const writeRawKey = (key: string, value: unknown): void => {
    upsertStmt.run(key, JSON.stringify(value));
  };

  const isSet = (key: string): boolean => selectStmt.get(key) !== undefined;

  const readField = (group: string, field: string): unknown => readRawKey(`${group}.${field}`);
  const writeField = (group: string, field: string, value: unknown): void =>
    writeRawKey(`${group}.${field}`, value);

  // API key generation happens inside a single write transaction so two
  // concurrent readers can never mint two keys: the first reader through
  // wins, and every later reader (including ones in other processes, once
  // the transaction commits) observes the same persisted value.
  const getDaemon = db.transaction((): DaemonSettings => {
    const bind = readField(SETTING_KEYS.daemon, 'bind') ?? DEFAULT_DAEMON.bind;
    const port = readField(SETTING_KEYS.daemon, 'port') ?? DEFAULT_DAEMON.port;
    let apiKey = readField(SETTING_KEYS.daemon, 'apiKey');
    if (apiKey === undefined) {
      apiKey = generateApiKey();
      writeField(SETTING_KEYS.daemon, 'apiKey', apiKey);
    }
    return validateDaemon({ bind, port, apiKey });
  });

  const setDaemon = (patch: Partial<DaemonSettings>): void => {
    const current = getDaemon();
    const next = validateDaemon({ ...current, ...patch });
    writeField(SETTING_KEYS.daemon, 'bind', next.bind);
    writeField(SETTING_KEYS.daemon, 'port', next.port);
    writeField(SETTING_KEYS.daemon, 'apiKey', next.apiKey);
  };

  const getBinaries = (): BinarySettings =>
    validateBinaries({
      ffmpeg: readField(SETTING_KEYS.binaries, 'ffmpeg') ?? DEFAULT_BINARIES.ffmpeg,
      ffprobe: readField(SETTING_KEYS.binaries, 'ffprobe') ?? DEFAULT_BINARIES.ffprobe,
    });

  const setBinaries = (patch: Partial<BinarySettings>): void => {
    const next = validateBinaries({ ...getBinaries(), ...patch });
    writeField(SETTING_KEYS.binaries, 'ffmpeg', next.ffmpeg);
    writeField(SETTING_KEYS.binaries, 'ffprobe', next.ffprobe);
  };

  const getScan = (): ScanSettings =>
    validateScan({
      watchEnabled: readField(SETTING_KEYS.scan, 'watchEnabled') ?? DEFAULT_SCAN.watchEnabled,
      rescanIntervalMs:
        readField(SETTING_KEYS.scan, 'rescanIntervalMs') ?? DEFAULT_SCAN.rescanIntervalMs,
      settleMs: readField(SETTING_KEYS.scan, 'settleMs') ?? DEFAULT_SCAN.settleMs,
      scanOnStart: readField(SETTING_KEYS.scan, 'scanOnStart') ?? DEFAULT_SCAN.scanOnStart,
    });

  const setScan = (patch: Partial<ScanSettings>): void => {
    const next = validateScan({ ...getScan(), ...patch });
    writeField(SETTING_KEYS.scan, 'watchEnabled', next.watchEnabled);
    writeField(SETTING_KEYS.scan, 'rescanIntervalMs', next.rescanIntervalMs);
    writeField(SETTING_KEYS.scan, 'settleMs', next.settleMs);
    writeField(SETTING_KEYS.scan, 'scanOnStart', next.scanOnStart);
  };

  const getHardware = (): HardwareSettings =>
    validateHardware({
      available: readField(SETTING_KEYS.hardware, 'available') ?? DEFAULT_HARDWARE.available,
      caps: readField(SETTING_KEYS.hardware, 'caps') ?? DEFAULT_HARDWARE.caps,
    });

  const setHardware = (patch: Partial<HardwareSettings>): void => {
    const next = validateHardware({ ...getHardware(), ...patch });
    writeField(SETTING_KEYS.hardware, 'available', next.available);
    writeField(SETTING_KEYS.hardware, 'caps', next.caps);
  };

  const asScheduleValidationError = (err: unknown): SettingValidationError => {
    if (err instanceof ScheduleConfigError) {
      return new SettingValidationError((err as ScheduleConfigError).message);
    }
    throw err;
  };

  const getSchedule = (): ScheduleConfig => {
    const timezone = readField(SETTING_KEYS.schedule, 'timezone') ?? DEFAULT_SCHEDULE.timezone;
    const baseCounts =
      readField(SETTING_KEYS.schedule, 'baseCounts') ?? DEFAULT_SCHEDULE.baseCounts;
    const windows = readField(SETTING_KEYS.schedule, 'windows') ?? DEFAULT_SCHEDULE.windows;
    const schedule = { timezone, baseCounts, windows } as ScheduleConfig;
    try {
      validateSchedule(schedule);
    } catch (err) {
      throw asScheduleValidationError(err);
    }
    return schedule;
  };

  const setSchedule = (config: ScheduleConfig): void => {
    try {
      validateSchedule(config);
    } catch (err) {
      throw asScheduleValidationError(err);
    }
    writeField(SETTING_KEYS.schedule, 'timezone', config.timezone);
    writeField(SETTING_KEYS.schedule, 'baseCounts', config.baseCounts);
    writeField(SETTING_KEYS.schedule, 'windows', config.windows);
  };

  return {
    getDaemon,
    setDaemon,
    getBinaries,
    setBinaries,
    getScan,
    setScan,
    getHardware,
    setHardware,
    getSchedule,
    setSchedule,
    isSet,
  };
};
