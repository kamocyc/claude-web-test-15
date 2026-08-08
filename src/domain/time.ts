/**
 * Time arithmetic for railway timetables.
 *
 * All times are `Sec` — seconds from 00:00:00 of the *service day*, and are
 * allowed to exceed 86400. Japanese timetables write the small hours of the
 * next morning as a continuation of the same operating day (24:30, 25:12),
 * and trains genuinely do run across that boundary, so wrapping at midnight
 * would break both display and ordering.
 *
 * There is deliberately no `Date` anywhere in the domain layer.
 */

import type { Sec, IsoDate } from './units';

export const SEC_PER_MIN = 60;
export const SEC_PER_HOUR = 3600;
export const SEC_PER_DAY = 86400;

/** Operating days conventionally start at 03:00, not midnight. */
export const DEFAULT_SERVICE_DAY_START: Sec = 3 * SEC_PER_HOUR;
/** 30:00 — i.e. 06:00 the following morning. */
export const DEFAULT_SERVICE_DAY_END: Sec = 30 * SEC_PER_HOUR;

/**
 * Parse a timetable time string into seconds.
 *
 * Accepts `H:MM`, `HH:MM`, `H:MM:SS`, `HHMM`, `HHMMSS`, and full-width digits
 * and colons (Japanese input methods produce these routinely). Hours may
 * exceed 23. Returns `undefined` for anything unparseable — callers decide
 * whether that is an error or an intentionally blank cell.
 */
export function parseTime(input: string): Sec | undefined {
  const s = normalizeDigits(input).trim();
  if (s === '') return undefined;

  const colon = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (colon) {
    const [, h, m, sec] = colon;
    return toSec(Number(h), Number(m), sec === undefined ? 0 : Number(sec));
  }

  const bare = /^(\d{3,6})$/.exec(s);
  if (bare) {
    const digits = bare[1]!;
    if (digits.length === 3) return toSec(Number(digits.slice(0, 1)), Number(digits.slice(1, 3)), 0);
    if (digits.length === 4) return toSec(Number(digits.slice(0, 2)), Number(digits.slice(2, 4)), 0);
    if (digits.length === 5) {
      return toSec(Number(digits.slice(0, 1)), Number(digits.slice(1, 3)), Number(digits.slice(3, 5)));
    }
    return toSec(Number(digits.slice(0, 2)), Number(digits.slice(2, 4)), Number(digits.slice(4, 6)));
  }

  return undefined;
}

function toSec(h: number, m: number, s: number): Sec | undefined {
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return undefined;
  if (m > 59 || s > 59 || h > 47) return undefined;
  return h * SEC_PER_HOUR + m * SEC_PER_MIN + s;
}

/** Convert full-width digits and colons to ASCII. */
function normalizeDigits(s: string): string {
  return s.replace(/[０-９：]/g, (c) =>
    c === '：' ? ':' : String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

export interface FormatTimeOptions {
  /** Include `:SS`. Default false. */
  seconds?: boolean;
  /** Pad the hour to two digits. Default true. */
  padHours?: boolean;
}

/**
 * Format seconds as a timetable time. 88200 renders as `24:30`, never `00:30`.
 * Negative input renders with a leading `-` (used for showing margins).
 */
export function formatTime(t: Sec, opts: FormatTimeOptions = {}): string {
  const { seconds = false, padHours = true } = opts;
  const sign = t < 0 ? '-' : '';
  const abs = Math.abs(Math.round(t));
  const h = Math.floor(abs / SEC_PER_HOUR);
  const m = Math.floor((abs % SEC_PER_HOUR) / SEC_PER_MIN);
  const s = abs % SEC_PER_MIN;
  const hh = padHours ? String(h).padStart(2, '0') : String(h);
  const mm = String(m).padStart(2, '0');
  if (!seconds) return `${sign}${hh}:${mm}`;
  return `${sign}${hh}:${mm}:${String(s).padStart(2, '0')}`;
}

/** Compact form used in dense grids: `0743`, or `074330` with seconds. */
export function formatTimeCompact(t: Sec, seconds = false): string {
  return formatTime(t, { seconds }).replace(/:/g, '');
}

/** Format a duration (not a clock time): 195 -> `3分15秒`, 180 -> `3分`. */
export function formatDuration(sec: number): string {
  const sign = sec < 0 ? '-' : '';
  const abs = Math.abs(Math.round(sec));
  const m = Math.floor(abs / SEC_PER_MIN);
  const s = abs % SEC_PER_MIN;
  if (m === 0) return `${sign}${s}秒`;
  if (s === 0) return `${sign}${m}分`;
  return `${sign}${m}分${s}秒`;
}

/** Round to the nearest multiple of `grain`. */
export function roundToGrain(t: Sec, grain: number): Sec {
  if (grain <= 1) return Math.round(t);
  return Math.round(t / grain) * grain;
}

/** Round up to the next multiple of `grain`. Used when padding dwell times. */
export function ceilToGrain(t: Sec, grain: number): Sec {
  if (grain <= 1) return Math.ceil(t);
  return Math.ceil(t / grain) * grain;
}

export function clampTime(t: Sec, from: Sec, to: Sec): Sec {
  return t < from ? from : t > to ? to : t;
}

/** Do the closed intervals [aFrom, aTo] and [bFrom, bTo] overlap? */
export function intervalsOverlap(aFrom: Sec, aTo: Sec, bFrom: Sec, bTo: Sec): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/** Seconds of overlap between two intervals; 0 when they are disjoint. */
export function overlapSeconds(aFrom: Sec, aTo: Sec, bFrom: Sec, bTo: Sec): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));
}

// ---------------------------------------------------------------------------
// Calendar dates. Plain 'YYYY-MM-DD' arithmetic, no Date object, no timezone.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function isIsoDate(s: string): s is IsoDate {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toEpochDay(d: IsoDate): number {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  return Math.floor(Date.UTC(y, m - 1, day) / DAY_MS);
}

function fromEpochDay(n: number): IsoDate {
  const ms = n * DAY_MS;
  const y = new Date(ms).getUTCFullYear();
  const m = new Date(ms).getUTCMonth() + 1;
  const d = new Date(ms).getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Whole days from `a` to `b`; negative when `b` precedes `a`. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function addDays(d: IsoDate, days: number): IsoDate {
  return fromEpochDay(toEpochDay(d) + days);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(d: IsoDate): number {
  return ((toEpochDay(d) + 4) % 7 + 7) % 7;
}

export function isWeekend(d: IsoDate): boolean {
  const w = dayOfWeek(d);
  return w === 0 || w === 6;
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
