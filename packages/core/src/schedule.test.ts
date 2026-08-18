import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  evaluateSchedule,
  ScheduleConfigError,
  validateSchedule,
  windowContains,
  zonedInstant,
  type ScheduleConfig,
  type ScheduleWindow,
} from './schedule.js';

// 2026-03-04 is a Wednesday. 08:30 UTC.
const WED_0830_UTC = Date.UTC(2026, 2, 4, 8, 30);

describe('zonedInstant', () => {
  it('reports weekday and minute-of-day in the configured zone, not the host zone', () => {
    expect(zonedInstant({ nowMs: WED_0830_UTC, timezone: 'UTC' })).toEqual({
      weekday: 3,
      minuteOfDay: 8 * 60 + 30,
    });
    // Same instant, a zone 10 hours ahead: still Wednesday, but the evening.
    expect(zonedInstant({ nowMs: WED_0830_UTC, timezone: 'Australia/Sydney' })).toEqual({
      weekday: 3,
      minuteOfDay: 19 * 60 + 30,
    });
    // And a zone far enough behind that it is still Tuesday there.
    expect(
      zonedInstant({ nowMs: Date.UTC(2026, 2, 4, 2, 0), timezone: 'America/Los_Angeles' }),
    ).toEqual({
      weekday: 2,
      minuteOfDay: 18 * 60,
    });
  });
});

describe('windowContains', () => {
  const overnight = {
    id: 'w',
    days: [],
    startMinute: 23 * 60,
    endMinute: 6 * 60,
    counts: { transcode: 6 },
  };

  it('includes the start minute and excludes the end minute', () => {
    const day = { id: 'w', days: [], startMinute: 480, endMinute: 1020, counts: {} };
    expect(windowContains(day, { weekday: 3, minuteOfDay: 480 })).toBe(true);
    expect(windowContains(day, { weekday: 3, minuteOfDay: 1019 })).toBe(true);
    expect(windowContains(day, { weekday: 3, minuteOfDay: 1020 })).toBe(false);
  });

  it('wraps past midnight when the end is at or before the start', () => {
    expect(windowContains(overnight, { weekday: 3, minuteOfDay: 23 * 60 + 1 })).toBe(true);
    expect(windowContains(overnight, { weekday: 4, minuteOfDay: 2 * 60 })).toBe(true);
    expect(windowContains(overnight, { weekday: 3, minuteOfDay: 12 * 60 })).toBe(false);
  });

  it('matches a wrapping window on the day it STARTED, not the day it spills into', () => {
    // Saturday 23:00 -> 06:00. At Sunday 02:00 the window is still the one
    // that started on Saturday, so a days list of [6] must match it and a
    // days list of [0] must not. Getting this backwards is how "six workers
    // overnight at the weekend" silently becomes "six on Sunday evening".
    const saturdayNight = { ...overnight, days: [6] };
    expect(windowContains(saturdayNight, { weekday: 0, minuteOfDay: 2 * 60 })).toBe(true);
    expect(windowContains(saturdayNight, { weekday: 6, minuteOfDay: 2 * 60 })).toBe(false);
  });
});

describe('evaluateSchedule', () => {
  it('returns the base counts when no window is active', () => {
    expect(evaluateSchedule({ schedule: DEFAULT_SCHEDULE, nowMs: WED_0830_UTC })).toEqual({
      transcode: 1,
      health: 0,
    });
  });

  it('lets an active window override only the classes it names', () => {
    const schedule: ScheduleConfig = {
      timezone: 'UTC',
      baseCounts: { transcode: 2, health: 1 },
      windows: [
        { id: 'day', days: [], startMinute: 480, endMinute: 1020, counts: { transcode: 6 } },
      ],
    };
    expect(evaluateSchedule({ schedule, nowMs: WED_0830_UTC })).toEqual({
      transcode: 6,
      health: 1,
    });
  });

  it('lets a later window win over an earlier one for the same class', () => {
    const schedule: ScheduleConfig = {
      timezone: 'UTC',
      baseCounts: { transcode: 2, health: 0 },
      windows: [
        { id: 'work', days: [], startMinute: 480, endMinute: 1020, counts: { transcode: 6 } },
        { id: 'quiet-wed', days: [3], startMinute: 480, endMinute: 1020, counts: { transcode: 0 } },
      ],
    };
    expect(evaluateSchedule({ schedule, nowMs: WED_0830_UTC }).transcode).toBe(0);
  });

  it('expresses a pause as a window of zero rather than a separate concept', () => {
    const schedule: ScheduleConfig = {
      timezone: 'UTC',
      baseCounts: { transcode: 4, health: 0 },
      windows: [{ id: 'off', days: [], startMinute: 0, endMinute: 1440, counts: { transcode: 0 } }],
    };
    expect(evaluateSchedule({ schedule, nowMs: WED_0830_UTC }).transcode).toBe(0);
  });

  it('evaluates in the configured timezone, so the same instant differs by zone', () => {
    const windows = [
      { id: 'night', days: [], startMinute: 23 * 60, endMinute: 6 * 60, counts: { transcode: 6 } },
    ];
    const base = { transcode: 1, health: 0 };
    expect(
      evaluateSchedule({
        schedule: { timezone: 'UTC', baseCounts: base, windows },
        nowMs: WED_0830_UTC,
      }).transcode,
    ).toBe(1);
    // Same instant is 00:30 in America/Los_Angeles (UTC-8 on this date,
    // before the US spring-forward on 2026-03-08) -- inside the window.
    expect(
      evaluateSchedule({
        schedule: { timezone: 'America/Los_Angeles', baseCounts: base, windows },
        nowMs: WED_0830_UTC,
      }).transcode,
    ).toBe(6);
  });

  it('never fires on a spring-forward local time that skips entirely', () => {
    // America/New_York, 2026-03-08: clocks jump 02:00 -> 03:00. A window of
    // 02:00-02:30 names a local time that never occurs that day, so it must
    // never be observed as active by any instant we evaluate.
    const schedule: ScheduleConfig = {
      timezone: 'America/New_York',
      baseCounts: { transcode: 1, health: 0 },
      windows: [
        {
          id: 'skip',
          days: [],
          startMinute: 2 * 60,
          endMinute: 2 * 60 + 30,
          counts: { transcode: 9 },
        },
      ],
    };
    // Sweep UTC instants across the transition at 5-minute resolution; the
    // window's target must never appear.
    const startUtc = Date.UTC(2026, 2, 8, 6, 0); // 01:00 EST
    const endUtc = Date.UTC(2026, 2, 8, 9, 0); // well past the transition
    for (let ms = startUtc; ms <= endUtc; ms += 5 * 60 * 1000) {
      expect(evaluateSchedule({ schedule, nowMs: ms }).transcode).toBe(1);
    }
  });

  it('is active across both passes of a repeated local time on fall-back', () => {
    // America/New_York, 2026-11-01: clocks fall back, so 01:00-02:00 local
    // occurs twice (once EDT, once EST). A window covering that hour must be
    // active on both real-world passes through it.
    const schedule: ScheduleConfig = {
      timezone: 'America/New_York',
      baseCounts: { transcode: 1, health: 0 },
      windows: [
        { id: 'repeat', days: [], startMinute: 60, endMinute: 120, counts: { transcode: 9 } },
      ],
    };
    // First pass: 01:30 EDT == 05:30 UTC.
    expect(evaluateSchedule({ schedule, nowMs: Date.UTC(2026, 10, 1, 5, 30) }).transcode).toBe(9);
    // Second pass: 01:30 EST == 06:30 UTC, one hour later in real time.
    expect(evaluateSchedule({ schedule, nowMs: Date.UTC(2026, 10, 1, 6, 30) }).transcode).toBe(9);
  });
});

describe('validateSchedule', () => {
  it('rejects an unknown timezone rather than silently falling back to UTC', () => {
    expect(() => validateSchedule({ ...DEFAULT_SCHEDULE, timezone: 'Middle/Earth' })).toThrow(
      ScheduleConfigError,
    );
  });

  it('rejects out-of-range minutes, weekdays and negative counts', () => {
    const bad = (window: Partial<ScheduleWindow>) =>
      validateSchedule({
        ...DEFAULT_SCHEDULE,
        windows: [{ id: 'x', days: [], startMinute: 0, endMinute: 60, counts: {}, ...window }],
      });
    expect(() => bad({ startMinute: 1440 })).toThrow(ScheduleConfigError);
    expect(() => bad({ endMinute: 0 })).toThrow(ScheduleConfigError);
    expect(() => bad({ days: [7] })).toThrow(ScheduleConfigError);
    expect(() => bad({ counts: { transcode: -1 } })).toThrow(ScheduleConfigError);
  });
});
