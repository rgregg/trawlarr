import type { WorkerClass } from './worker-class.js';

/**
 * A weekly period during which the given per-class worker counts are in
 * force. A class this window doesn't name keeps its `ScheduleConfig.baseCounts`
 * value — see `evaluateSchedule`, which applies windows in array order so a
 * later window wins over an earlier one for the same class.
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

/** Weekday and minute-of-day derived from an instant in a given IANA zone. */
export interface ZonedInstant {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes past local midnight, 0..1439. */
  minuteOfDay: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Projects an instant onto weekday and minute-of-day in `timezone`, using
 * `Intl.DateTimeFormat` (Node 22 ships full ICU, so no dependency is
 * required). This is the only place a UTC instant is turned into local wall
 * clock in this module — `evaluateSchedule` never does the reverse
 * (local wall clock -> instant), which is what keeps DST unambiguous. See
 * `evaluateSchedule` for why that direction matters.
 */
export const zonedInstant = (input: { nowMs: number; timezone: string }): ZonedInstant => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(input.nowMs));
  const find = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    weekday: WEEKDAY_INDEX[find('weekday')] ?? 0,
    minuteOfDay: Number(find('hour')) * 60 + Number(find('minute')),
  };
};

/**
 * Whether `at` falls inside `window`. The start minute is included and the
 * end minute is excluded; `endMinute <= startMinute` means the window wraps
 * past midnight (e.g. 23:00-06:00). A wrapping window is attributed to the
 * day it STARTED on, not the day(s) it spills into: at Sunday 02:00 inside a
 * Saturday-23:00-to-06:00 window, `days: [6]` must match and `days: [0]`
 * must not.
 */
export const windowContains = (window: ScheduleWindow, at: ZonedInstant): boolean => {
  const wraps = window.endMinute <= window.startMinute;
  const inSpan = wraps
    ? at.minuteOfDay >= window.startMinute || at.minuteOfDay < window.endMinute
    : at.minuteOfDay >= window.startMinute && at.minuteOfDay < window.endMinute;
  if (!inSpan) return false;
  if (window.days.length === 0) return true;
  // A wrapping window that we are in BEFORE its end minute began yesterday.
  const startedOn = wraps && at.minuteOfDay < window.endMinute ? (at.weekday + 6) % 7 : at.weekday;
  return window.days.includes(startedOn);
};

/**
 * Computes the target worker count per class for `nowMs`. Starts from
 * `schedule.baseCounts` and applies every active window in array order,
 * each window overwriting only the classes it names — so later windows win
 * over earlier ones for the same class, and a class no active window names
 * keeps its base count (or the count set by an earlier active window, if a
 * later active window doesn't mention it). When no window is active, the
 * result is exactly `baseCounts`.
 *
 * On DST: this function never converts a local wall-clock boundary into an
 * instant. It converts the *current instant* `nowMs` into local wall clock
 * via `zonedInstant` and asks whether that falls inside each window, which
 * is always well-defined in that direction — "which instant does local
 * 01:30 mean" only becomes a question when going the other way, and this
 * code never goes the other way. Because the supervisor (Task 7) re-evaluates
 * on every tick rather than firing at boundaries, the practical result is:
 * on a spring-forward day, a window whose span falls entirely in the
 * skipped local hour (e.g. 02:00-02:30 when clocks jump from 02:00 to
 * 03:00) simply never becomes active for any instant, because no instant
 * ever projects to a minute-of-day in that range. On a fall-back day, a
 * window covering the repeated local hour is active across both real-world
 * passes through it, because two different instants both project to the
 * same minute-of-day.
 */
export const evaluateSchedule = (input: {
  schedule: ScheduleConfig;
  nowMs: number;
}): Record<WorkerClass, number> => {
  const at = zonedInstant({ nowMs: input.nowMs, timezone: input.schedule.timezone });
  const counts: Record<WorkerClass, number> = { ...input.schedule.baseCounts };
  for (const window of input.schedule.windows) {
    if (!windowContains(window, at)) continue;
    for (const [workerClass, count] of Object.entries(window.counts) as Array<
      [WorkerClass, number]
    >) {
      counts[workerClass] = count;
    }
  }
  return counts;
};

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
 * hand-edited row is a named error rather than a downstream mystery.
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
