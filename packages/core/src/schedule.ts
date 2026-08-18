import type { WorkerClass } from './worker-class.js';

/**
 * A weekly period during which the given per-class worker counts are in
 * force. A class this window doesn't name keeps its `ScheduleConfig.baseCounts`
 * value — see `evaluateSchedule` (Task 2 of the P2b daemon phase), which is
 * intentionally left for that task; this file only carries the shapes and
 * the write-time validation the settings repository needs today.
 */
export interface ScheduleWindow {
  id: string;
  /** 0 = Sunday … 6 = Saturday, in the configured timezone. Empty means every day. */
  days: number[];
  /** Minutes past local midnight, 0..1439. */
  startMinute: number;
  /** Minutes past local midnight, 1..1440. May be <= startMinute, meaning the window wraps past midnight. */
  endMinute: number;
  /** Worker counts in force while this window is active. A class omitted here keeps its base count. */
  counts: Partial<Record<WorkerClass, number>>;
}

export interface ScheduleConfig {
  /** IANA zone, e.g. 'Europe/London'. Never the host's — a container with TZ unset must not silently shift everyone's overnight window. */
  timezone: string;
  baseCounts: Record<WorkerClass, number>;
  windows: ScheduleWindow[];
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  timezone: 'UTC',
  baseCounts: { transcode: 1, health: 0 },
  windows: [],
};

export class ScheduleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleConfigError';
  }
}

const isWholeNumberInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * Validates a schedule so a bad value can never be stored, and so a
 * hand-edited row is a named error rather than a downstream mystery. Reused
 * unchanged from the shape specified for Task 2 of
 * docs/superpowers/plans/2026-08-18-p2b-daemon.md; `evaluateSchedule`,
 * `zonedInstant` and `windowContains` are left for that task since nothing
 * in this phase's Task 1 needs them.
 */
export const validateSchedule = (schedule: ScheduleConfig): void => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone });
  } catch (err) {
    if (err instanceof RangeError) {
      throw new ScheduleConfigError(`Unknown IANA timezone: "${schedule.timezone}".`);
    }
    throw err;
  }

  for (const [workerClass, count] of Object.entries(schedule.baseCounts)) {
    if (!isWholeNumberInRange(count, 0, Number.MAX_SAFE_INTEGER)) {
      throw new ScheduleConfigError(
        `baseCounts.${workerClass} must be a non-negative whole number, got ${JSON.stringify(count)}.`,
      );
    }
  }

  for (const window of schedule.windows) {
    if (!isWholeNumberInRange(window.startMinute, 0, 1439)) {
      throw new ScheduleConfigError(
        `Window "${window.id}" startMinute must be between 0 and 1439, got ${JSON.stringify(window.startMinute)}.`,
      );
    }
    if (!isWholeNumberInRange(window.endMinute, 1, 1440)) {
      throw new ScheduleConfigError(
        `Window "${window.id}" endMinute must be between 1 and 1440, got ${JSON.stringify(window.endMinute)}.`,
      );
    }
    for (const day of window.days) {
      if (!isWholeNumberInRange(day, 0, 6)) {
        throw new ScheduleConfigError(
          `Window "${window.id}" has an invalid day ${JSON.stringify(day)}; days must be 0 (Sunday) through 6 (Saturday).`,
        );
      }
    }
    for (const [workerClass, count] of Object.entries(window.counts)) {
      if (!isWholeNumberInRange(count, 0, Number.MAX_SAFE_INTEGER)) {
        throw new ScheduleConfigError(
          `Window "${window.id}" counts.${workerClass} must be a non-negative whole number, got ${JSON.stringify(count)}.`,
        );
      }
    }
  }
};
