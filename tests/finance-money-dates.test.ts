import { describe, expect, it } from "vitest";
import { dayInTimeZone, parseLexwareDate } from "../src/finance/dates.js";
import { MAX_ABS_AMOUNT, parseAmountToCents } from "../src/finance/money.js";

const BERLIN = "Europe/Berlin";

describe("parseAmountToCents — exact cents, never a silent 0", () => {
  it.each([
    [318.3, 31830],
    [20.14, 2014],
    [202.23, 20223],
    [4430.34, 443034],
    [0.1, 10],
    [0, 0],
    [-12.5, -1250],
    [999999999999.99, 99999999999999],
  ])("%s -> %s cents", (input, cents) => {
    expect(parseAmountToCents(input)).toEqual({ ok: true, cents, precisionReduced: false });
  });

  it("round-trips every two-decimal amount from 0.00 to 2000.00 exactly (no float drift)", () => {
    for (let c = 0; c <= 200_000; c++) {
      const r = parseAmountToCents(c / 100);
      if (!r.ok || r.cents !== c || r.precisionReduced) throw new Error(`drift at ${c}: ${JSON.stringify(r)}`);
    }
  });

  it("rounds more than two decimals half away from zero and reports it", () => {
    expect(parseAmountToCents(1.005)).toEqual({ ok: true, cents: 101, precisionReduced: true });
    expect(parseAmountToCents(-1.005)).toEqual({ ok: true, cents: -101, precisionReduced: true });
    expect(parseAmountToCents(2.344)).toEqual({ ok: true, cents: 234, precisionReduced: true });
    expect(parseAmountToCents(0.1 + 0.2)).toEqual({ ok: true, cents: 30, precisionReduced: true });
    // Trailing zeros beyond the cent are not a precision loss.
    expect(parseAmountToCents(Number("12.340"))).toEqual({ ok: true, cents: 1234, precisionReduced: false });
  });

  it("never returns negative zero", () => {
    const r = parseAmountToCents(-0);
    expect(r.ok && Object.is(r.cents, 0)).toBe(true);
  });

  it.each([
    [undefined, "FIELD_ABSENT"],
    [null, "FIELD_ABSENT"],
    ["12.50", "INVALID_TYPE"],
    [true, "INVALID_TYPE"],
    [{}, "INVALID_TYPE"],
    [Number.NaN, "NOT_FINITE"],
    [Number.POSITIVE_INFINITY, "NOT_FINITE"],
    [MAX_ABS_AMOUNT * 10, "UNSAFE_AMOUNT"],
    [-MAX_ABS_AMOUNT * 10, "UNSAFE_AMOUNT"],
  ])("refuses %s (%s) instead of guessing", (input, reason) => {
    expect(parseAmountToCents(input)).toEqual({ ok: false, reason });
  });

  it("handles exponent notation for tiny values", () => {
    expect(parseAmountToCents(1e-7)).toEqual({ ok: true, cents: 0, precisionReduced: true });
  });
});

describe("parseLexwareDate — business calendar days in Europe/Berlin", () => {
  it("reads a Lexware timestamp with offset", () => {
    expect(parseLexwareDate("2026-09-29T09:29:53.000+02:00", BERLIN)).toEqual({
      ok: true,
      day: "2026-09-29",
      instant: "2026-09-29T07:29:53.000Z",
    });
  });

  it("assigns just-after-midnight vouchers to the new month regardless of the process time zone", () => {
    // 00:30 Berlin on Oct 1st is still Sep 30th in UTC.
    expect(parseLexwareDate("2026-10-01T00:30:00.000+02:00", BERLIN)).toMatchObject({ day: "2026-10-01" });
    expect(parseLexwareDate("2026-09-30T23:30:00.000Z", BERLIN)).toMatchObject({ day: "2026-10-01" });
    // Winter time (UTC+1) at the year boundary.
    expect(parseLexwareDate("2026-12-31T23:30:00Z", BERLIN)).toMatchObject({ day: "2027-01-01" });
    // DST change day.
    expect(parseLexwareDate("2026-03-29T01:30:00Z", BERLIN)).toMatchObject({ day: "2026-03-29" });
  });

  it("honours another configured time zone", () => {
    expect(parseLexwareDate("2026-10-01T02:00:00.000+02:00", "America/New_York")).toMatchObject({ day: "2026-09-30" });
  });

  it("accepts plain dates and validates the calendar", () => {
    expect(parseLexwareDate("2028-02-29", BERLIN)).toEqual({ ok: true, day: "2028-02-29", instant: null });
    expect(parseLexwareDate("2026-02-29", BERLIN)).toEqual({ ok: false, reason: "INVALID_FORMAT" });
    expect(parseLexwareDate("2026-13-01T00:00:00Z", BERLIN)).toEqual({ ok: false, reason: "INVALID_FORMAT" });
  });

  it.each([
    [undefined, "FIELD_ABSENT"],
    [null, "FIELD_ABSENT"],
    ["", "EMPTY_STRING"],
    ["   ", "EMPTY_STRING"],
    [20260929, "INVALID_TYPE"],
    ["next tuesday", "INVALID_FORMAT"],
    ["2026-09-29T09:29:53", "TIMEZONE_ABSENT"],
    ["2026-09-29T09:29:53.000", "TIMEZONE_ABSENT"],
  ])("refuses %s (%s)", (input, reason) => {
    expect(parseLexwareDate(input, BERLIN)).toEqual({ ok: false, reason });
  });

  it("dayInTimeZone formats YYYY-MM-DD", () => {
    expect(dayInTimeZone(new Date("2026-01-05T12:00:00Z"), BERLIN)).toBe("2026-01-05");
  });
});
