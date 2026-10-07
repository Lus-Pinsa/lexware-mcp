/**
 * Calendar-day handling for Lexware timestamps.
 *
 * Lexware returns timestamps with an explicit offset (e.g. `2026-09-29T14:05:20.000+02:00`). The business
 * day of such an instant is computed in the configured time zone (default Europe/Berlin), so a voucher
 * dated just after midnight on the 1st belongs to the new month regardless of the server's own time zone.
 * Timestamps without an offset are ambiguous and are refused, never guessed.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export type DateParse =
  | { readonly ok: true; readonly day: string; readonly instant: string | null }
  | { readonly ok: false; readonly reason: "FIELD_ABSENT" | "EMPTY_STRING" | "INVALID_TYPE" | "INVALID_FORMAT" | "TIMEZONE_ABSENT" };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Calendar day (`YYYY-MM-DD`) of an instant in `timeZone`. */
export function dayInTimeZone(date: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isValidCalendarDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** Parse a Lexware date or timestamp into a business calendar day (and, for timestamps, a UTC instant). */
export function parseLexwareDate(raw: unknown, timeZone: string): DateParse {
  if (raw === undefined || raw === null) return { ok: false, reason: "FIELD_ABSENT" };
  if (typeof raw !== "string") return { ok: false, reason: "INVALID_TYPE" };
  const s = raw.trim();
  if (s === "") return { ok: false, reason: "EMPTY_STRING" };

  const dateOnly = DATE_ONLY.exec(s);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    if (!isValidCalendarDay(Number(y), Number(m), Number(d))) return { ok: false, reason: "INVALID_FORMAT" };
    return { ok: true, day: s, instant: null };
  }

  if (!ISO_WITH_OFFSET.test(s)) {
    return /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s)
      ? { ok: false, reason: "TIMEZONE_ABSENT" }
      : { ok: false, reason: "INVALID_FORMAT" };
  }
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  if (!isValidCalendarDay(y, m, d)) return { ok: false, reason: "INVALID_FORMAT" };
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return { ok: false, reason: "INVALID_FORMAT" };
  const date = new Date(ms);
  return { ok: true, day: dayInTimeZone(date, timeZone), instant: date.toISOString() };
}
