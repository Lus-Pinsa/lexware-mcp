import { describe, expect, it } from "vitest";
import {
  absoluteChangeAtLeast,
  addCents,
  percentToHundredths,
  relativeChange,
  relativeChangeAtLeast,
  subtractCents,
} from "../src/finance/amounts.js";
import {
  addDays,
  daysBetween,
  daysInMonth,
  formatDayDe,
  isValidDay,
  monthEnd,
  previousMonthStart,
  sameDayPreviousMonth,
} from "../src/finance/calendar.js";
import type { FinanceRecord } from "../src/finance/model.js";
import { REVENUE_SCOPE_NOTE } from "../src/finance/model.js";
import { DEFAULT_ANOMALY_CONFIG, comparePeriods, comparisonPeriods, resolveAnomalyConfig } from "../src/finance/periods.js";
import { fromRow, grossConflict, rec, rng, row, shuffle, statusConflict, without } from "./fixtures/intelligence-fixtures.js";

describe("calendar", () => {
  it("knows leap years and month lengths", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(isValidDay("2024-02-29")).toBe(true);
    expect(isValidDay("2025-02-29")).toBe(false);
    expect(isValidDay("2026-13-01")).toBe(false);
    expect(isValidDay("2026-1-01")).toBe(false);
    expect(isValidDay(20260101)).toBe(false);
  });

  it("clamps the previous month's same day to its end (February, leap year)", () => {
    expect(sameDayPreviousMonth("2024-03-31")).toBe("2024-02-29");
    expect(sameDayPreviousMonth("2025-03-31")).toBe("2025-02-28");
    expect(sameDayPreviousMonth("2025-03-28")).toBe("2025-02-28");
    expect(sameDayPreviousMonth("2026-05-31")).toBe("2026-04-30");
    expect(sameDayPreviousMonth("2026-01-15")).toBe("2025-12-15");
  });

  it("does day arithmetic across month, year and DST boundaries", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30"); // DST change in Europe/Berlin is irrelevant for days
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysBetween("2026-10-25", "2026-10-26")).toBe(1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2026-10-07", "2026-10-01")).toBe(-6);
    expect(previousMonthStart("2026-01-31")).toBe("2025-12-01");
    expect(monthEnd("2024-02-10")).toBe("2024-02-29");
    expect(formatDayDe("2026-10-07")).toBe("07.10.2026");
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addDays("2026-02-01", 0.5)).toThrow(RangeError);
  });

  it("builds MTD, previous same period and previous full month", () => {
    expect(comparisonPeriods("2024-03-31")).toEqual({
      current: { from: "2024-03-01", to: "2024-03-31" },
      previousSamePeriod: { from: "2024-02-01", to: "2024-02-29" },
      previousFull: { from: "2024-02-01", to: "2024-02-29" },
    });
    expect(comparisonPeriods("2026-10-01")).toEqual({
      current: { from: "2026-10-01", to: "2026-10-01" },
      previousSamePeriod: { from: "2026-09-01", to: "2026-09-01" },
      previousFull: { from: "2026-09-01", to: "2026-09-30" },
    });
    expect(comparisonPeriods("2026-01-07").previousFull).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});

describe("exact amount arithmetic", () => {
  it("never loses precision: overflow is 'not computable'", () => {
    expect(addCents(1, 2)).toBe(3);
    expect(addCents(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
    expect(addCents(1.5, 1)).toBeNull();
    expect(subtractCents(Number.MIN_SAFE_INTEGER, 1)).toBeNull();
  });

  it("relative change: rounding half away from zero, division by zero is not defined", () => {
    expect(relativeChange(11225, 10000)).toEqual({ ok: true, tenthsOfPercent: 123 }); // +12.25 % → +12.3 %
    expect(relativeChange(8775, 10000)).toEqual({ ok: true, tenthsOfPercent: -123 });
    expect(relativeChange(5, 0)).toEqual({ ok: false, reason: "BASE_ZERO" });
    expect(relativeChange(0, 0)).toEqual({ ok: false, reason: "BASE_ZERO" });
    expect(relativeChange(Number.NaN, 1)).toEqual({ ok: false, reason: "NOT_COMPUTABLE" });
    expect(relativeChange(-50, -100)).toEqual({ ok: true, tenthsOfPercent: 500 }); // relative to |base|
  });

  it("threshold checks are exact on the boundary", () => {
    const pct = percentToHundredths(30);
    expect(relativeChangeAtLeast(13000, 10000, pct)).toBe(true); // exactly +30 %
    expect(relativeChangeAtLeast(12999, 10000, pct)).toBe(false);
    expect(relativeChangeAtLeast(7000, 10000, pct)).toBe(true); // exactly −30 %
    expect(relativeChangeAtLeast(5, 0, pct)).toBe(false);
    expect(absoluteChangeAtLeast(35000, 10000, 25000)).toBe(true); // exactly 250.00 €
    expect(absoluteChangeAtLeast(34999, 10000, 25000)).toBe(false);
    expect(() => percentToHundredths(Number.NaN)).toThrow(RangeError);
    expect(() => percentToHundredths(-1)).toThrow(RangeError);
    expect(() => percentToHundredths(30.001)).toThrow(RangeError);
  });
});

const AS_OF = "2026-10-07";

function purchase(n: number, day: string, amount: number, overrides: Record<string, unknown> = {}): FinanceRecord {
  return rec(n, { voucherDate: day, dueDate: day, totalAmount: amount, openAmount: 0, voucherStatus: "paid", ...overrides });
}
function sale(n: number, day: string, amount: number, overrides: Record<string, unknown> = {}): FinanceRecord {
  return rec(n, { voucherType: "invoice", voucherDate: day, dueDate: day, totalAmount: amount, openAmount: 0, voucherStatus: "paid", contactName: "Testkunde A", ...overrides });
}

describe("comparePeriods", () => {
  it("assigns documents by voucher day to MTD / previous same period / previous full month", () => {
    const records = [
      purchase(1, "2026-10-01", 100),
      purchase(2, "2026-10-07", 50),
      purchase(3, "2026-10-08", 999), // after asOf: in no period
      purchase(4, "2026-09-07", 40),
      purchase(5, "2026-09-08", 10), // previous month, after the same-period end
      purchase(6, "2026-08-31", 1000), // before the previous month
    ];
    const c = comparePeriods(records, AS_OF, { dataComplete: true });
    expect(c.current.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: 15000, records: 2 }]);
    expect(c.previousSamePeriod.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: 4000, records: 1 }]);
    expect(c.previousFull.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: 5000, records: 2 }]);
    const exp = c.vsPreviousSamePeriod.money.find((m) => m.metric === "reliableExpenses");
    expect(exp).toEqual({ metric: "reliableExpenses", currency: "EUR", current: 15000, comparison: 4000, absoluteDiff: 11000, relative: { ok: true, tenthsOfPercent: 2750 } });
  });

  it("sums only reviewed documents without CRITICAL issues; everything else is counted as excluded", () => {
    const records = [
      purchase(1, "2026-10-02", 100),
      purchase(2, "2026-10-02", 70, { voucherStatus: "unchecked" }),
      rec(3, { voucherDate: "2026-10-02", totalAmount: 30, voucherStatus: "paid", openAmount: 0 }, grossConflict),
      fromRow(without(row(4, { voucherDate: "2026-10-02", voucherStatus: "paid", openAmount: 0 }), "totalAmount")),
      rec(5, { voucherDate: "2026-10-02", totalAmount: 20 }, statusConflict),
      purchase(6, "2026-10-02", 500, { voucherStatus: "voided" }),
    ];
    const m = comparePeriods(records, AS_OF, { dataComplete: true }).current;
    expect(m.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: 10000, records: 1 }]);
    expect(m.reliableExpenses.excluded).toEqual({ UNREVIEWED: 1, STATUS_UNKNOWN: 1, CRITICAL_ISSUE: 2, AMOUNT_NOT_USABLE: 0 });
    expect(m.reliableExpenses.documents).toBe(5);
    expect(m.purchaseInvoices).toEqual({ total: 5, unreviewed: 1 });
    expect(m.voidedOrDraft).toBe(1);
  });

  it("keeps Lexware invoice revenue separate from expenses and carries the POS scope note", () => {
    const c = comparePeriods([sale(1, "2026-10-03", 400), purchase(2, "2026-10-03", 100)], AS_OF, { dataComplete: true });
    expect(c.current.lexwareInvoiceRevenue.byCurrency).toEqual([{ currency: "EUR", cents: 40000, records: 1 }]);
    expect(c.current.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: 10000, records: 1 }]);
    expect(c.revenueScopeNote).toBe(REVENUE_SCOPE_NOTE);
    expect(JSON.stringify(c)).not.toMatch(/"(revenue|umsatz)"/i);
  });

  it("never nets credit notes or down-payment invoices (counted only)", () => {
    const c = comparePeriods(
      [
        purchase(1, "2026-10-03", 100),
        purchase(2, "2026-10-03", 30, { voucherType: "purchasecreditnote" }),
        sale(3, "2026-10-03", 200, { voucherType: "downpaymentinvoice" }),
        sale(4, "2026-10-03", 20, { voucherType: "salescreditnote" }),
      ],
      AS_OF,
      { dataComplete: true },
    );
    expect(c.current.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: 10000, records: 1 }]);
    expect(c.current.lexwareInvoiceRevenue.byCurrency).toEqual([]);
    expect(c.current.notNetted).toEqual({ purchaseCreditNotes: 1, salesCreditNotes: 1, downPaymentInvoices: 1 });
  });

  it("division by zero: relative change is 'not defined', never Infinity", () => {
    const c = comparePeriods([purchase(1, "2026-10-02", 500)], AS_OF, { dataComplete: true });
    const exp = c.vsPreviousSamePeriod.money.find((m) => m.metric === "reliableExpenses");
    expect(exp?.relative).toEqual({ ok: false, reason: "BASE_ZERO" });
    expect(c.anomalies).toEqual([]);
    expect(c.notEvaluated).toContainEqual({ subject: { type: "METRIC", metric: "reliableExpenses" }, reason: "BASE_ZERO" });
    expect(JSON.stringify(c)).not.toMatch(/Infinity|NaN/);
  });

  it("anomaly rule: >= 30 % AND >= 250 € (both exact on the boundary)", () => {
    const at = comparePeriods([purchase(1, "2026-10-02", 1083.33), purchase(2, "2026-09-02", 833.33)], AS_OF, { dataComplete: true });
    const metricAnomalies = at.anomalies.filter((a) => a.subject.type === "METRIC");
    expect(metricAnomalies).toHaveLength(1); // +250.00 € and +30.0 %
    expect(metricAnomalies[0]).toMatchObject({ subject: { type: "METRIC", metric: "reliableExpenses" }, absoluteDiff: 25000, relativeTenthsOfPercent: 300 });
    // The same supplier carries the whole change, so the supplier-level rule fires as well.
    expect(at.anomalies.filter((a) => a.subject.type === "SUPPLIER")).toHaveLength(1);
    const smallAbs = comparePeriods([purchase(1, "2026-10-02", 200), purchase(2, "2026-09-02", 100)], AS_OF, { dataComplete: true });
    expect(smallAbs.anomalies.filter((a) => a.subject.type === "METRIC")).toEqual([]); // +100 %, but only +100 €
    const smallRel = comparePeriods([purchase(1, "2026-10-02", 1200), purchase(2, "2026-09-02", 1000)], AS_OF, { dataComplete: true });
    expect(smallRel.anomalies.filter((a) => a.subject.type === "METRIC")).toEqual([]); // +200 € … +20 %
    const drop = comparePeriods([purchase(1, "2026-10-02", 100), purchase(2, "2026-09-02", 1000)], AS_OF, { dataComplete: true });
    expect(drop.anomalies.find((a) => a.subject.type === "METRIC")).toMatchObject({ absoluteDiff: -90000, relativeTenthsOfPercent: -900 });
  });

  it("the rule is configurable and validated", () => {
    const c = comparePeriods([purchase(1, "2026-10-02", 200), purchase(2, "2026-09-02", 100)], AS_OF, {
      dataComplete: true,
      config: { minAbsoluteChangeCents: 5000 },
    });
    expect(c.anomalies.some((a) => a.subject.type === "METRIC")).toBe(true);
    expect(c.rule.minAbsoluteChangeCents).toBe(5000);
    expect(() => resolveAnomalyConfig({ minRelativeChangePercent: Number.NaN })).toThrow(RangeError);
    expect(() => resolveAnomalyConfig({ minAbsoluteChangeCents: -1 })).toThrow(RangeError);
    expect(() => resolveAnomalyConfig({ currency: "euro" })).toThrow(RangeError);
    expect(() => resolveAnomalyConfig({ maxUnreviewedSharePercent: 101 })).toThrow(RangeError);
  });

  it("does not evaluate anomalies on incomplete data", () => {
    const c = comparePeriods([purchase(1, "2026-10-02", 100), purchase(2, "2026-09-02", 1000)], AS_OF, { dataComplete: false });
    expect(c.anomalies).toEqual([]);
    expect(c.notEvaluated).toEqual([
      { subject: { type: "METRIC", metric: "reliableExpenses" }, reason: "DATA_INCOMPLETE" },
      { subject: { type: "METRIC", metric: "lexwareInvoiceRevenue" }, reason: "DATA_INCOMPLETE" },
      { subject: { type: "SUPPLIERS" }, reason: "DATA_INCOMPLETE" },
    ]);
    expect(c.dataComplete).toBe(false);
  });

  it("does not evaluate expense anomalies when too many purchase documents are unreviewed (no fake drops)", () => {
    const records = [
      purchase(1, "2026-10-02", 100),
      ...Array.from({ length: 5 }, (_, i) => purchase(10 + i, "2026-10-02", 300, { voucherStatus: "unchecked" })),
      purchase(2, "2026-09-02", 1000),
    ];
    const c = comparePeriods(records, AS_OF, { dataComplete: true });
    expect(c.anomalies).toEqual([]);
    expect(c.notEvaluated).toContainEqual({ subject: { type: "METRIC", metric: "reliableExpenses" }, reason: "UNREVIEWED_SHARE_TOO_HIGH" });
    expect(c.notEvaluated).toContainEqual({ subject: { type: "SUPPLIERS" }, reason: "UNREVIEWED_SHARE_TOO_HIGH" });
  });

  it("ranks suppliers by reliable expenses and flags supplier anomalies by the same rule", () => {
    const records = [
      purchase(1, "2026-10-02", 900, { contactName: "Testlieferant A" }),
      purchase(2, "2026-10-03", 100, { contactName: "Testlieferant B" }),
      purchase(3, "2026-10-03", 50, { contactName: undefined }),
      purchase(4, "2026-09-02", 300, { contactName: "Testlieferant A" }),
      purchase(5, "2026-09-03", 100, { contactName: "Testlieferant B" }),
    ];
    const c = comparePeriods(records, AS_OF, { dataComplete: true });
    expect(c.current.topSuppliers.items.map((s) => [s.name, s.cents])).toEqual([
      ["Testlieferant A", 90000],
      ["Testlieferant B", 10000],
    ]);
    expect(c.current.topSuppliers.unidentified).toEqual({ records: 1, cents: 5000 });
    const supplierAnomalies = c.anomalies.filter((a) => a.subject.type === "SUPPLIER");
    expect(supplierAnomalies).toHaveLength(1);
    expect(supplierAnomalies[0]).toMatchObject({ subject: { name: "Testlieferant A" }, absoluteDiff: 60000, relativeTenthsOfPercent: 2000 });
  });

  it("cost categories are 'not available' without details", () => {
    const c = comparePeriods([purchase(1, "2026-10-02", 100)], AS_OF, { dataComplete: true });
    expect(c.current.topCostCategories).toMatchObject({ available: false, reason: "DETAILS_NOT_LOADED" });
  });

  it("missing or disputed voucher days are unassigned, never guessed", () => {
    const c = comparePeriods([fromRow(without(row(1), "voucherDate")), purchase(2, "2026-10-02", 10)], AS_OF, { dataComplete: true });
    expect(c.unassignedFinancialRecords).toBe(1);
    expect(c.current.purchaseInvoices.total).toBe(1);
  });

  it("an overflowing sum is not computable instead of rounded", () => {
    const huge = (n: number, day: string) =>
      rec(n, { voucherDate: day, totalAmount: 10, voucherStatus: "paid", openAmount: 0 }, (r) => ({
        ...r,
        grossCents: { value: Number.MAX_SAFE_INTEGER - 1, quality: "STRUCTURED", source: "voucherlist" },
      }));
    const c = comparePeriods([huge(1, "2026-10-02"), huge(2, "2026-10-03"), purchase(3, "2026-09-02", 1000)], AS_OF, { dataComplete: true });
    expect(c.current.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: null, records: 2 }]);
    expect(c.notEvaluated).toContainEqual({ subject: { type: "METRIC", metric: "reliableExpenses" }, reason: "NOT_COMPUTABLE" });
  });

  it("property: deterministic under permutation; period sums equal the sum of included documents", () => {
    const random = rng(21);
    const records: FinanceRecord[] = [];
    for (let n = 1; n <= 120; n += 1) {
      const month = random() < 0.5 ? "09" : "10";
      records.push(
        rec(n, {
          voucherType: random() < 0.7 ? "purchaseinvoice" : "invoice",
          voucherStatus: ["paid", "open", "unchecked", "voided"][Math.floor(random() * 4)],
          voucherDate: `2026-${month}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`,
          totalAmount: Math.round(random() * 100000) / 100,
          openAmount: 0,
          contactName: ["Testlieferant A", "Testlieferant B", undefined][Math.floor(random() * 3)],
        }),
      );
    }
    const base = comparePeriods(records, AS_OF, { dataComplete: true });
    for (let i = 0; i < 10; i += 1) expect(comparePeriods(shuffle(records, random), AS_OF, { dataComplete: true })).toEqual(base);
    const included = records.filter(
      (r) =>
        r.kind === "EXPENSE" &&
        r.role === "INVOICE" &&
        ["paid", "open"].includes(String(r.status.value)) &&
        r.voucherDate.value !== null &&
        r.voucherDate.value >= "2026-10-01" &&
        r.voucherDate.value <= AS_OF,
    );
    const expected = included.reduce((s, r) => s + (r.grossCents.value ?? 0), 0);
    expect(base.current.reliableExpenses.byCurrency[0]?.cents ?? 0).toBe(expected);
  });
});

describe("review round 1: periods and anomaly rule", () => {
  it("documents excluded from a sum (missing amount, CRITICAL, unknown status) block the anomaly rule instead of faking a drop", () => {
    const noAmount = fromRow(without(row(1, { voucherDate: "2026-10-02", voucherStatus: "paid", openAmount: 0 }), "totalAmount"));
    const c = comparePeriods([noAmount, purchase(2, "2026-09-02", 1000)], AS_OF, { dataComplete: true });
    expect(c.anomalies).toEqual([]);
    expect(c.notEvaluated).toContainEqual({ subject: { type: "METRIC", metric: "reliableExpenses" }, reason: "EXCLUDED_DOCUMENTS" });
    expect(c.notEvaluated).toContainEqual({ subject: { type: "SUPPLIERS" }, reason: "EXCLUDED_DOCUMENTS" });
  });

  it("the anomaly baseline is the same days of the previous month, not the full month", () => {
    const base = [purchase(2, "2026-09-02", 1000), purchase(3, "2026-09-20", 5000, { contactName: "Testlieferant B" })];
    const equal = comparePeriods([purchase(1, "2026-10-02", 1000), ...base], AS_OF, { dataComplete: true });
    expect(equal.anomalies.filter((a) => a.subject.type === "METRIC")).toEqual([]); // vs full month it would be −83 %
    const doubled = comparePeriods([purchase(1, "2026-10-02", 2000), ...base], AS_OF, { dataComplete: true });
    expect(doubled.anomalies.find((a) => a.subject.type === "METRIC")).toMatchObject({ comparison: 100000, relativeTenthsOfPercent: 1000 });
  });

  it("the relative threshold applies on its own (>= 250 € but < 30 % is no anomaly) and the defaults are pinned", () => {
    const c = comparePeriods([purchase(1, "2026-10-02", 2000), purchase(2, "2026-09-02", 1700)], AS_OF, { dataComplete: true });
    expect(c.anomalies.filter((a) => a.subject.type === "METRIC")).toEqual([]);
    expect(DEFAULT_ANOMALY_CONFIG).toEqual({ minRelativeChangePercent: 30, minAbsoluteChangeCents: 25000, currency: "EUR", maxUnreviewedSharePercent: 10, topSuppliers: 5 });
  });

  it("the unreviewed-share rule allows exactly 10 % and blocks above it", () => {
    const reviewed = (from: number, count: number) => Array.from({ length: count }, (_, i) => purchase(from + i, "2026-10-02", 100, { contactName: `Testlieferant ${from + i}` }));
    const unchecked = (n: number) => purchase(n, "2026-10-02", 100, { voucherStatus: "unchecked", contactName: `Testlieferant ${n}` });
    const prev = Array.from({ length: 10 }, (_, i) => purchase(100 + i, "2026-09-02", 10, { contactName: `Testlieferant ${100 + i}` }));
    const atTen = comparePeriods([...reviewed(1, 9), unchecked(50), ...prev], AS_OF, { dataComplete: true });
    expect(atTen.notEvaluated.some((n) => n.reason === "UNREVIEWED_SHARE_TOO_HIGH")).toBe(false);
    const above = comparePeriods([...reviewed(1, 8), unchecked(50), unchecked(51), ...prev], AS_OF, { dataComplete: true });
    expect(above.notEvaluated).toContainEqual({ subject: { type: "METRIC", metric: "reliableExpenses" }, reason: "UNREVIEWED_SHARE_TOO_HIGH" });
  });

  it("an open credit note (unknown direction) is listed nowhere in open receivables/payables and does not break the comparison", () => {
    const c = comparePeriods([purchase(1, "2026-10-02", 50, { voucherType: "purchasecreditnote", voucherStatus: "open", openAmount: 50 })], AS_OF, { dataComplete: true });
    expect(c.current.openNow.PAYABLE.items).toBe(0);
    expect(c.current.openNow.RECEIVABLE.items).toBe(0);
  });

  it("February at record level: the 29th of a leap year is in the previous same period of 31 March", () => {
    const c = comparePeriods([purchase(1, "2024-03-31", 10), purchase(2, "2024-02-29", 20)], "2024-03-31", { dataComplete: true });
    expect(c.previousSamePeriod.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: 2000, records: 1 }]);
    expect(c.current.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: 1000, records: 1 }]);
  });

  it("other currencies never trigger the EUR rule", () => {
    const c = comparePeriods([purchase(1, "2026-10-02", 5000, { currency: "CHF" }), purchase(2, "2026-09-02", 100, { currency: "CHF" })], AS_OF, { dataComplete: true });
    expect(c.anomalies).toEqual([]);
    expect(c.vsPreviousSamePeriod.money.find((m) => m.metric === "reliableExpenses" && m.currency === "CHF")?.absoluteDiff).toBe(490000);
  });
});

describe("review round 3: unassigned documents", () => {
  it("reviewed purchase invoices without a usable voucher day block expense and supplier anomalies", () => {
    const unassigned = fromRow(without(row(9, { voucherStatus: "paid", openAmount: 0, totalAmount: 50 }), "voucherDate"));
    const c = comparePeriods([purchase(1, "2026-09-03", 1000), purchase(2, "2026-10-03", 3000), unassigned], AS_OF, { dataComplete: true });
    expect(c.unassignedFinancialRecords).toBe(1);
    expect(c.anomalies).toEqual([]);
    expect(c.notEvaluated).toContainEqual({ subject: { type: "METRIC", metric: "reliableExpenses" }, reason: "UNASSIGNED_DOCUMENTS" });
    expect(c.notEvaluated).toContainEqual({ subject: { type: "SUPPLIERS" }, reason: "UNASSIGNED_DOCUMENTS" });
    // An unreviewed inbox document without a date does not block (it is never summed anyway).
    const inbox = fromRow(without(row(10, { voucherStatus: "unchecked" }), "voucherDate", "openAmount"));
    const d = comparePeriods([purchase(1, "2026-09-03", 1000), purchase(2, "2026-10-03", 3000), inbox], AS_OF, { dataComplete: true });
    expect(d.notEvaluated.some((n) => n.reason === "UNASSIGNED_DOCUMENTS")).toBe(false);
  });
});

describe("review round 3: every exclusion cause and booked statuses", () => {
  const base = () => [purchase(1, "2026-10-03", 3000), purchase(2, "2026-09-03", 1000)];
  it.each([
    ["unknown status (current period)", () => rec(9, { voucherDate: "2026-10-02", totalAmount: 20 }, statusConflict)],
    ["unusable currency (current period)", () => fromRow(without(row(9, { voucherDate: "2026-10-02", voucherStatus: "paid", openAmount: 0 }), "currency"))],
    ["CRITICAL issue (previous same period)", () => rec(9, { voucherDate: "2026-09-02", totalAmount: 30, voucherStatus: "paid", openAmount: 0 }, grossConflict)],
  ])("an excluded reviewed document (%s) blocks the anomaly rule", (_label, excluded) => {
    const c = comparePeriods([...base(), excluded()], AS_OF, { dataComplete: true });
    expect(c.anomalies).toEqual([]);
    expect(c.notEvaluated).toContainEqual({ subject: { type: "METRIC", metric: "reliableExpenses" }, reason: "EXCLUDED_DOCUMENTS" });
  });

  it("overdue and statuses of unverified payment meaning (e.g. sepadebit) count as booked expenses; a missing status value does not", () => {
    const c = comparePeriods(
      [
        purchase(1, "2026-10-02", 100, { voucherStatus: "overdue", openAmount: 100 }),
        purchase(2, "2026-10-02", 200, { voucherStatus: "sepadebit", openAmount: 200 }),
        rec(3, { voucherDate: "2026-10-02", totalAmount: 400, voucherStatus: "paid", openAmount: 0 }, (r) => ({ ...r, status: { value: null, quality: "MISSING", source: "voucherlist", reason: "FIELD_ABSENT" } })),
      ],
      AS_OF,
      { dataComplete: true },
    );
    expect(c.current.reliableExpenses.byCurrency).toEqual([{ currency: "EUR", cents: 30000, records: 2 }]);
    expect(c.current.reliableExpenses.excluded.STATUS_UNKNOWN).toBe(1);
  });

  it("UNVERIFIED and unsafe values are never summed", () => {
    const unverifiedGross = rec(1, { voucherDate: "2026-10-02", voucherStatus: "paid", openAmount: 0 }, (r) => ({ ...r, grossCents: { value: 99900, quality: "UNVERIFIED", source: "pdf-text" } }));
    const unsafeGross = rec(2, { voucherDate: "2026-10-02", voucherStatus: "paid", openAmount: 0 }, (r) => ({ ...r, grossCents: { value: 1e300, quality: "STRUCTURED", source: "voucherlist" } }));
    const c = comparePeriods([unverifiedGross, unsafeGross], AS_OF, { dataComplete: true });
    expect(c.current.reliableExpenses.byCurrency).toEqual([]);
    expect(c.current.reliableExpenses.excluded.AMOUNT_NOT_USABLE + c.current.reliableExpenses.excluded.CRITICAL_ISSUE).toBe(2);
  });

  it("an explicit undefined in the anomaly config falls back to the default", () => {
    expect(resolveAnomalyConfig({ minRelativeChangePercent: undefined }).minRelativeChangePercent).toBe(30);
  });

  it("addDays refuses offsets that leave the calendar", () => {
    expect(() => addDays("2026-10-07", 1e12)).toThrow(RangeError);
  });
});
