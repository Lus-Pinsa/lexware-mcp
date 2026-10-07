import { describe, expect, it } from "vitest";
import { DEFAULT_DATA_QUALITY_CONFIG, assessDataQuality, resolveDataQualityConfig } from "../src/finance/data-quality.js";
import type { FinanceRecord } from "../src/finance/model.js";
import { analyzeOpenItems } from "../src/finance/open-items.js";
import { fromRow, grossConflict, openConflict, rec, row, statusConflict, without } from "./fixtures/intelligence-fixtures.js";

const clean = (n: number, overrides: Record<string, unknown> = {}) =>
  rec(n, { voucherStatus: "paid", openAmount: 0, dueDate: "2026-10-20", ...overrides });

function assess(records: FinanceRecord[], extra: Partial<Parameters<typeof assessDataQuality>[0]> = {}) {
  return assessDataQuality({ records, listComplete: true, fetchFailures: 0, ...extra });
}

describe("assessDataQuality — grade from counted findings", () => {
  it("GOOD when nothing limits the data", () => {
    const r = assess([clean(1), clean(2)]);
    expect(r.grade).toBe("GOOD");
    expect(r.triggeredBy).toEqual([]);
    expect(r.scope).toEqual({ records: 2, reviewedRecords: 2, unreviewedRecords: 0, openItems: null });
  });

  it("NO_DATA when the list is complete but there is nothing in scope (voided, drafts, non-financial excluded)", () => {
    const r = assess([clean(1, { voucherStatus: "voided" }), clean(2, { voucherType: "quotation" })]);
    expect(r.grade).toBe("NO_DATA");
  });

  it("POOR whenever the list is incomplete — even with no records", () => {
    expect(assess([], { listComplete: false }).grade).toBe("POOR");
    const r = assess([clean(1)], { listComplete: false });
    expect(r.grade).toBe("POOR");
    expect(r.triggeredBy).toEqual(["LIST_INCOMPLETE"]);
  });

  it("CRITICAL records: one is LIMITED, >= 10 % of the reviewed records is POOR (exact boundary)", () => {
    const nine = Array.from({ length: 9 }, (_, i) => clean(i + 1));
    const tenRecords = [...nine, rec(10, { voucherStatus: "paid", openAmount: 0 }, grossConflict)];
    const atTen = assess(tenRecords);
    expect(atTen.grade).toBe("POOR"); // 1 of 10 = 10 %
    expect(atTen.findings.find((f) => f.code === "CRITICAL_RECORDS")).toEqual({ code: "CRITICAL_RECORDS", count: 1, of: 10, effect: "POOR" });
    const eleven = assess([...tenRecords, clean(11)]);
    expect(eleven.grade).toBe("LIMITED"); // 1 of 11 < 10 %
    // The disputed gross also makes a reviewed document's amount unusable (round 2: AMOUNT_MISSING limits too).
    expect(eleven.triggeredBy).toEqual(["CRITICAL_RECORDS", "SOURCE_CONFLICT", "AMOUNT_MISSING"]);
  });

  it("CRITICAL issues of unreviewed inbox documents do not count against the reviewed data (they are coverage)", () => {
    const inbox = fromRow(without(row(2, { voucherStatus: "unchecked" }), "totalAmount", "openAmount"));
    const r = assess([clean(1), clean(3), clean(4), clean(5), inbox]);
    expect(r.findings.find((f) => f.code === "CRITICAL_RECORDS")).toBeUndefined();
    expect(r.findings.find((f) => f.code === "UNREVIEWED")).toEqual({ code: "UNREVIEWED", count: 1, of: 5, effect: "NONE" });
    expect(r.findings.find((f) => f.code === "AMOUNT_MISSING")).toMatchObject({ count: 1, effect: "NONE" });
    expect(r.grade).toBe("GOOD");
  });

  it("unreviewed share >= 25 % is LIMITED (exact boundary)", () => {
    const base = [clean(1), clean(2), clean(3)];
    const atQuarter = assess([...base, clean(4, { voucherStatus: "unchecked" })]);
    expect(atQuarter.grade).toBe("LIMITED");
    expect(atQuarter.triggeredBy).toEqual(["UNREVIEWED"]);
    const below = assess([...base, clean(5), clean(4, { voucherStatus: "unchecked" })]);
    expect(below.grade).toBe("GOOD"); // 1 of 5 = 20 %
  });

  it("unidentified counterparties >= 25 % is LIMITED", () => {
    const r = assess([clean(1), clean(2), clean(3), fromRow(without(row(4, { voucherStatus: "paid", openAmount: 0 }), "contactName"))]);
    expect(r.triggeredBy).toEqual(["COUNTERPARTY_MISSING"]);
  });

  it("any source conflict, unknown status or failed fetch is LIMITED", () => {
    expect(assess([clean(1), rec(2, {}, openConflict)]).triggeredBy).toContain("SOURCE_CONFLICT");
    expect(assess([clean(1), rec(2, {}, statusConflict)]).triggeredBy).toEqual(expect.arrayContaining(["STATUS_UNKNOWN"]));
    expect(assess([clean(1)], { fetchFailures: 2 })).toMatchObject({ grade: "LIMITED", triggeredBy: ["FETCH_FAILED"] });
  });

  it("open items without a reliable due date: >= 50 % is LIMITED", () => {
    const records = [
      rec(1, { voucherStatus: "open", dueDate: "2026-10-20" }),
      rec(2, { voucherStatus: "overdue", voucherDate: "2026-09-01", dueDate: "2026-09-01" }),
    ];
    const r = assess(records, { openItems: analyzeOpenItems(records, "2026-10-07") });
    expect(r.findings.find((f) => f.code === "DUE_DATE_UNRELIABLE")).toEqual({ code: "DUE_DATE_UNRELIABLE", count: 1, of: 2, effect: "LIMITED" });
    expect(r.scope.openItems).toBe(2);
  });

  it("informational findings are counted without changing the grade", () => {
    const r = assess([clean(1), clean(2, { voucherType: "purchasecreditnote" }), clean(3), clean(4)]);
    expect(r.findings.find((f) => f.code === "DIRECTION_UNCLEAR")).toEqual({ code: "DIRECTION_UNCLEAR", count: 1, of: 4, effect: "NONE" });
    expect(r.grade).toBe("GOOD");
  });

  it("is reproducible and order-independent", () => {
    const records = [clean(1), rec(2, {}, grossConflict), clean(3, { voucherStatus: "unchecked" })];
    expect(assess(records)).toEqual(assess([...records].reverse()));
  });

  it("thresholds are configurable and validated", () => {
    expect(resolveDataQualityConfig()).toEqual(DEFAULT_DATA_QUALITY_CONFIG);
    const strict = assessDataQuality(
      { records: [clean(1), clean(2), clean(3), clean(4), clean(5, { voucherStatus: "unchecked" })], listComplete: true, fetchFailures: 0 },
      { limitedUnreviewedSharePercent: 20 },
    );
    expect(strict.grade).toBe("LIMITED");
    expect(() => resolveDataQualityConfig({ poorCriticalSharePercent: Number.NaN })).toThrow(RangeError);
    expect(() => resolveDataQualityConfig({ limitedUnreviewedSharePercent: 150 })).toThrow(RangeError);
    expect(() => assessDataQuality({ records: [], listComplete: true, fetchFailures: -1 })).toThrow(RangeError);
  });
});

describe("review round 1: data quality", () => {
  it("below the share thresholds the counterparty and due-date findings do not limit the grade", () => {
    const fiveWithOneUnidentified = [clean(1), clean(2), clean(3), clean(4), fromRow(without(row(5, { voucherStatus: "paid", openAmount: 0 }), "contactName"))];
    expect(assess(fiveWithOneUnidentified).findings.find((f) => f.code === "COUNTERPARTY_MISSING")).toMatchObject({ count: 1, of: 5, effect: "NONE" });
    const open = [
      rec(1, { voucherStatus: "open", dueDate: "2026-10-20" }),
      rec(2, { voucherStatus: "open", dueDate: "2026-10-21", contactName: "Testlieferant B" }),
      rec(3, { voucherStatus: "overdue", voucherDate: "2026-09-01", dueDate: "2026-09-01", contactName: "Testlieferant C" }),
    ];
    const r = assess(open, { openItems: analyzeOpenItems(open, "2026-10-07") });
    expect(r.findings.find((f) => f.code === "DUE_DATE_UNRELIABLE")).toEqual({ code: "DUE_DATE_UNRELIABLE", count: 1, of: 3, effect: "NONE" });
  });

  it("failed fetches recorded on the records count even when the loader total is 0", () => {
    const failed = rec(2, {}, (r) => ({ ...r, provenance: { ...r.provenance, detail: "FAILED" } }));
    expect(assess([clean(1), failed]).triggeredBy).toContain("FETCH_FAILED");
  });

  it("a repeated id counts once", () => {
    const a = clean(1);
    expect(assess([a, a, clean(2)]).scope.records).toBe(2);
  });
});

describe("review round 2: data quality", () => {
  it("rejected rows and reviewed documents without a usable currency limit the grade", () => {
    expect(assess([clean(1)], { rejectedRows: 2 })).toMatchObject({ grade: "LIMITED", triggeredBy: ["ROWS_REJECTED"] });
    const noCurrency = fromRow(without(row(2, { voucherStatus: "paid", openAmount: 0 }), "currency"));
    const r = assess([clean(1), noCurrency, clean(3), clean(4)]);
    expect(r.findings.find((f) => f.code === "AMOUNT_MISSING")).toMatchObject({ count: 1, effect: "LIMITED" });
    expect(() => assess([], { rejectedRows: -1 })).toThrow(RangeError);
  });

  it("an explicit undefined threshold falls back to the default", () => {
    expect(resolveDataQualityConfig({ poorCriticalSharePercent: undefined })).toEqual(DEFAULT_DATA_QUALITY_CONFIG);
  });
});
