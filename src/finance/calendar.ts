/**
 * Pure calendar-day arithmetic on `YYYY-MM-DD` strings.
 *
 * Business days are already expressed in the business time zone (see dates.ts), so day arithmetic here is plain
 * proleptic-Gregorian counting: no clock, no time zone, no DST. Invalid days throw RangeError (caller error).
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export interface DayRange {
  /** Inclusive first day. */
  readonly from: string;
  /** Inclusive last day. */
  readonly to: string;
}

function parts(day: string): { y: number; m: number; d: number } | null {
  const match = DAY.exec(day);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** Number of days in `month` (1–12) of `year`. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** True for a real calendar day in `YYYY-MM-DD` form. */
export function isValidDay(value: unknown): value is string {
  return typeof value === "string" && parts(value) !== null;
}

function requireParts(day: string): { y: number; m: number; d: number } {
  const p = parts(day);
  if (!p) throw new RangeError("expected a valid YYYY-MM-DD day");
  return p;
}

function utcMs(y: number, m: number, d: number): number {
  // setUTCFullYear keeps years 0000–0099 literal (Date.UTC would map them to 1900–1999).
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getTime();
}

function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Signed number of days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  const a = requireParts(from);
  const b = requireParts(to);
  return Math.round((utcMs(b.y, b.m, b.d) - utcMs(a.y, a.m, a.d)) / MS_PER_DAY);
}

/** `day` shifted by `n` days. The result must stay within years 0000–9999. */
export function addDays(day: string, n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError("day offset must be an integer");
  const p = requireParts(day);
  const date = new Date(utcMs(p.y, p.m, p.d) + n * MS_PER_DAY);
  const y = date.getUTCFullYear();
  if (y < 0 || y > 9999) throw new RangeError("day out of range");
  return format(y, date.getUTCMonth() + 1, date.getUTCDate());
}

/** First day of the month of `day`. */
export function monthStart(day: string): string {
  const p = requireParts(day);
  return format(p.y, p.m, 1);
}

/** Last day of the month of `day`. */
export function monthEnd(day: string): string {
  const p = requireParts(day);
  return format(p.y, p.m, daysInMonth(p.y, p.m));
}

/** First day of the month before the month of `day`. */
export function previousMonthStart(day: string): string {
  const p = requireParts(day);
  if (p.m === 1) {
    if (p.y === 0) throw new RangeError("day out of range");
    return format(p.y - 1, 12, 1);
  }
  return format(p.y, p.m - 1, 1);
}

/**
 * The same day-of-month in the previous month, clamped to that month's last day
 * (e.g. 2024-03-31 → 2024-02-29, 2025-03-30 → 2025-02-28).
 */
export function sameDayPreviousMonth(day: string): string {
  const p = requireParts(day);
  const start = requireParts(previousMonthStart(day));
  return format(start.y, start.m, Math.min(p.d, daysInMonth(start.y, start.m)));
}

/** Inclusive range membership. */
export function inRange(day: string, range: DayRange): boolean {
  return day >= range.from && day <= range.to;
}

/** `DD.MM.YYYY` for display. */
export function formatDayDe(day: string): string {
  const p = requireParts(day);
  return `${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")}.${String(p.y).padStart(4, "0")}`;
}
