import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  formatDuration,
  formatTime,
  formatTimeCompact,
  intervalsOverlap,
  overlapSeconds,
  parseTime,
  roundToGrain,
} from './time';

describe('parseTime', () => {
  it('parses colon forms', () => {
    expect(parseTime('7:43')).toBe(7 * 3600 + 43 * 60);
    expect(parseTime('07:43')).toBe(7 * 3600 + 43 * 60);
    expect(parseTime('07:43:30')).toBe(7 * 3600 + 43 * 60 + 30);
  });

  it('parses bare digit forms', () => {
    expect(parseTime('743')).toBe(7 * 3600 + 43 * 60);
    expect(parseTime('0743')).toBe(7 * 3600 + 43 * 60);
    expect(parseTime('074330')).toBe(7 * 3600 + 43 * 60 + 30);
  });

  it('accepts hours past midnight — the whole point of the Sec type', () => {
    expect(parseTime('24:30')).toBe(24 * 3600 + 30 * 60);
    expect(parseTime('2530')).toBe(25 * 3600 + 30 * 60);
    expect(parseTime('25:12:30')).toBe(25 * 3600 + 12 * 60 + 30);
  });

  it('accepts full-width digits from Japanese IMEs', () => {
    expect(parseTime('０７：４３')).toBe(7 * 3600 + 43 * 60);
  });

  it('rejects nonsense rather than guessing', () => {
    expect(parseTime('')).toBeUndefined();
    expect(parseTime('  ')).toBeUndefined();
    expect(parseTime('あ')).toBeUndefined();
    expect(parseTime('07:75')).toBeUndefined();
    expect(parseTime('99:00')).toBeUndefined();
  });
});

describe('formatTime', () => {
  it('renders past-midnight times as 24:xx, never 00:xx', () => {
    expect(formatTime(24 * 3600 + 30 * 60)).toBe('24:30');
    expect(formatTime(25 * 3600 + 12 * 60)).toBe('25:12');
  });

  it('renders seconds on request', () => {
    expect(formatTime(7 * 3600 + 43 * 60 + 5, { seconds: true })).toBe('07:43:05');
  });

  it('round-trips with parseTime across the midnight boundary', () => {
    for (const t of [0, 3 * 3600, 23 * 3600 + 59 * 60, 24 * 3600, 88200, 90750]) {
      expect(parseTime(formatTime(t, { seconds: true }))).toBe(t);
    }
  });

  it('formats compactly for dense grids', () => {
    expect(formatTimeCompact(7 * 3600 + 43 * 60)).toBe('0743');
  });
});

describe('formatDuration', () => {
  it('reads as a duration, not a clock time', () => {
    expect(formatDuration(180)).toBe('3分');
    expect(formatDuration(195)).toBe('3分15秒');
    expect(formatDuration(45)).toBe('45秒');
    expect(formatDuration(-90)).toBe('-1分30秒');
  });
});

describe('roundToGrain', () => {
  it('snaps to the timetable grain', () => {
    expect(roundToGrain(127, 5)).toBe(125);
    expect(roundToGrain(128, 5)).toBe(130);
    expect(roundToGrain(127, 1)).toBe(127);
  });
});

describe('interval helpers', () => {
  it('detects overlap exclusive of touching endpoints', () => {
    expect(intervalsOverlap(0, 100, 100, 200)).toBe(false);
    expect(intervalsOverlap(0, 100, 99, 200)).toBe(true);
    expect(overlapSeconds(0, 100, 60, 200)).toBe(40);
    expect(overlapSeconds(0, 100, 100, 200)).toBe(0);
  });
});

describe('date arithmetic', () => {
  it('counts days without timezone drift', () => {
    expect(daysBetween('2026-04-06', '2026-04-13')).toBe(7);
    expect(daysBetween('2026-04-13', '2026-04-06')).toBe(-7);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1); // 2026 is not a leap year
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-04-06', 30)).toBe('2026-05-06');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});
