import { describe, expect, it } from "vitest";
import type { FinanceRecord } from "../src/finance/model.js";
import { OPEN_STATES, analyzeOpenItems, classifyOpenItem } from "../src/finance/open-items.js";
import {
  dueConflict,
  fromRow,
  grossConflict,
  openConflict,
  paymentNotAvailable,
  paymentTerm,
  rec,
  rng,
  row,
  shuffle,
  statusConflict,
  without,
} from "./fixtures/intelligence-fixtures.js";

const AS_OF = "2026-10-07";

function item(record: FinanceRecord, asOf = AS_OF) {
  const out = classifyOpenItem(record, asOf);
  if ("excluded" in out) throw new Error(`excluded: ${out.excluded}`);
  return out.item;
}

describe("open items — conservative classification", () => {
  it("OPEN_CONFIRMED: open, reliable own due date (differs from the voucher date), not yet due", () => {
    const i = item(rec(1, { voucherDate: "2026-10-01", dueDate: "2026-10-15" }));
    expect(i).toMatchObject({ status: "OPEN_CONFIRMED", direction: "PAYABLE", dueDateBasis: "LEXWARE_FIELD", dueDateReliable: true, amountUsable: true });
    expect(i.ageDays).toBe(6);
    expect(i.daysPastDue).toBeNull();
  });

  it("PAID_CONFIRMED: Lexware status paid and open amount exactly 0", () => {
    const i = item(rec(1, { voucherStatus: "paid", openAmount: 0 }));
    expect(i.status).toBe("PAID_CONFIRMED");
    expect(i.amountUsable).toBe(false);
  });

  it("OVERDUE_CONFIRMED: a reliable due date in the past (stated payment term)", () => {
    const i = item(rec(1, { voucherType: "invoice", voucherStatus: "overdue", voucherDate: "2026-09-01", dueDate: "2026-09-01" }, paymentTerm));
    expect(i).toMatchObject({ status: "OVERDUE_CONFIRMED", direction: "RECEIVABLE", daysPastDue: 36, dueDateReliable: true });
  });

  it("a due date equal to the voucher date without payment term is NEVER confirmed overdue", () => {
    const i = item(rec(1, { voucherStatus: "overdue", voucherDate: "2026-09-01", dueDate: "2026-09-01" }));
    expect(i.status).toBe("POSSIBLY_OVERDUE");
    expect(i.reasons).toEqual(expect.arrayContaining(["DUE_DATE_POSSIBLE_DEFAULT", "LEXWARE_STATUS_OVERDUE_NOT_CONFIRMED"]));
    expect(i.daysPastDue).toBeNull();
  });

  it("DUE_DATE_UNRELIABLE: possible-default due date not yet passed, or a missing due date", () => {
    expect(item(rec(1, { voucherDate: "2026-10-07", dueDate: "2026-10-07" })).status).toBe("DUE_DATE_UNRELIABLE");
    const missingDue = item(fromRow(without(row(1), "dueDate")));
    expect(missingDue.status).toBe("DUE_DATE_UNRELIABLE");
    expect(missingDue.reasons).toContain("DUE_DATE_MISSING");
    const conflicting = item(rec(1, {}, dueConflict));
    expect(conflicting.status).toBe("DUE_DATE_UNRELIABLE");
    expect(conflicting.reasons).toContain("DUE_DATE_CONFLICT");
  });

  it("Lexware 'overdue' with a reliable due date in the future is only POSSIBLY_OVERDUE (disagreement surfaced)", () => {
    const i = item(rec(1, { voucherStatus: "overdue", dueDate: "2026-10-20" }));
    expect(i.status).toBe("POSSIBLY_OVERDUE");
    expect(i.reasons).toContain("LEXWARE_STATUS_OVERDUE_NOT_CONFIRMED");
  });

  it("Lexware 'overdue' without any due date is POSSIBLY_OVERDUE", () => {
    const i = item(fromRow(without(row(1, { voucherStatus: "overdue" }), "dueDate")));
    expect(i.status).toBe("POSSIBLY_OVERDUE");
  });

  it("due today is not overdue", () => {
    expect(item(rec(1, { voucherDate: "2026-09-01", dueDate: AS_OF })).status).toBe("OPEN_CONFIRMED");
  });

  it("missing payment information stays visible as a reason and does not change the status", () => {
    const i = item(rec(1, {}, paymentNotAvailable));
    expect(i.status).toBe("OPEN_CONFIRMED");
    expect(i.paymentInfo).toBe("NOT_AVAILABLE");
    expect(i.reasons).toContain("PAYMENT_INFO_NOT_AVAILABLE");
    expect(item(rec(2)).paymentInfo).toBe("NOT_CHECKED");
  });

  it("unknown direction: credit notes (sign unverified) and unknown voucher types", () => {
    const credit = item(rec(1, { voucherType: "purchasecreditnote" }));
    expect(credit.direction).toBe("UNKNOWN");
    expect(credit.reasons).toContain("DIRECTION_UNVERIFIED_CREDIT_NOTE");
    const unknown = item(rec(2, { voucherType: "somethingnew" }));
    expect(unknown.direction).toBe("UNKNOWN");
    expect(unknown.reasons).toContain("DIRECTION_UNKNOWN_VOUCHER_TYPE");
  });

  it("unreviewed inbox documents are STATUS_UNKNOWN, never open or paid (their open amount is absent)", () => {
    const i = item(fromRow(without(row(1, { voucherStatus: "unchecked" }), "openAmount")));
    expect(i.status).toBe("STATUS_UNKNOWN");
    expect(i.reasons).toContain("STATUS_UNCHECKED");
    expect(i.amountUsable).toBe(false);
  });

  it("statuses whose meaning is not verified (e.g. sepadebit) are STATUS_UNKNOWN", () => {
    const i = item(rec(1, { voucherStatus: "sepadebit" }));
    expect(i.status).toBe("STATUS_UNKNOWN");
    expect(i.reasons).toContain("STATUS_MEANING_UNVERIFIED");
  });

  it.each([
    ["open with open amount 0", { openAmount: 0 }, "OPEN_AMOUNT_ZERO_WHILE_OPEN"],
    ["open with a negative open amount", { openAmount: -5 }, "OPEN_AMOUNT_NEGATIVE"],
    ["paid with a positive open amount", { voucherStatus: "paid", openAmount: 10 }, "OPEN_AMOUNT_POSITIVE_WHILE_PAID"],
  ])("contradiction (%s) is STATUS_UNKNOWN with a reason", (_l, overrides, reason) => {
    const i = item(rec(1, overrides));
    expect(i.status).toBe("STATUS_UNKNOWN");
    expect(i.reasons).toContain(reason);
    expect(i.amountUsable).toBe(false);
  });

  it("paid without a usable open amount is not confirmed", () => {
    const i = item(fromRow(without(row(1, { voucherStatus: "paid" }), "openAmount")));
    expect(i.status).toBe("STATUS_UNKNOWN");
    expect(i.reasons).toContain("OPEN_AMOUNT_MISSING");
  });

  it("a disputed status or open amount is never resolved", () => {
    const s = item(rec(1, {}, statusConflict));
    expect(s.status).toBe("STATUS_UNKNOWN");
    expect(s.reasons).toContain("STATUS_CONFLICT");
    const o = item(rec(2, {}, openConflict));
    expect(o.status).toBe("OPEN_CONFIRMED");
    expect(o.amountUsable).toBe(false);
    expect(o.reasons).toContain("OPEN_AMOUNT_CONFLICT");
  });

  it("an open amount larger than the gross amount is a data error (not totalled); smaller is PARTIALLY_PAID", () => {
    const over = item(rec(1, { totalAmount: 50, openAmount: 80 }));
    expect(over.reasons).toContain("OPEN_AMOUNT_EXCEEDS_GROSS");
    expect(over.amountUsable).toBe(false);
    const partial = item(rec(2, { totalAmount: 100, openAmount: 40 }));
    expect(partial.reasons).toContain("PARTIALLY_PAID");
    expect(partial.amountUsable).toBe(true);
  });

  it("records with a CRITICAL issue never count in totals (binding PR 1 rule)", () => {
    const i = item(rec(1, {}, grossConflict));
    expect(i.criticalIssues).toContain("GROSS_SOURCES_DIFFER");
    expect(i.reasons).toContain("CRITICAL_DATA_ISSUE");
    expect(i.amountUsable).toBe(false);
  });

  it("future-dated vouchers have no age", () => {
    const i = item(rec(1, { voucherDate: "2026-10-09", dueDate: "2026-10-20" }));
    expect(i.ageDays).toBeNull();
    expect(i.reasons).toContain("VOUCHER_DATE_IN_FUTURE");
  });

  it("voided, draft and non-financial documents are excluded", () => {
    expect(classifyOpenItem(rec(1, { voucherStatus: "voided" }), AS_OF)).toEqual({ excluded: "VOIDED" });
    expect(classifyOpenItem(rec(1, { voucherStatus: "draft" }), AS_OF)).toEqual({ excluded: "DRAFT" });
    expect(classifyOpenItem(rec(1, { voucherType: "deliverynote" }), AS_OF)).toEqual({ excluded: "NON_FINANCIAL" });
  });

  it("rejects an invalid reference day", () => {
    expect(() => classifyOpenItem(rec(1), "2026-02-30")).toThrow(RangeError);
    expect(() => analyzeOpenItems([], "07.10.2026")).toThrow(RangeError);
  });
});

describe("analyzeOpenItems — totals and determinism", () => {
  const fleet = (): FinanceRecord[] => [
    rec(1, { voucherType: "invoice", voucherStatus: "overdue", voucherDate: "2026-09-01", dueDate: "2026-09-01", totalAmount: 300, openAmount: 300 }, paymentTerm),
    rec(2, { voucherType: "invoice", voucherStatus: "overdue", voucherDate: "2026-09-10", dueDate: "2026-09-10", totalAmount: 200, openAmount: 150 }),
    rec(3, { voucherStatus: "open", dueDate: "2026-10-20", totalAmount: 80, openAmount: 80 }),
    rec(4, { voucherStatus: "open", dueDate: "2026-10-20", totalAmount: 50, openAmount: 80 }), // exceeds gross: not totalled
    rec(5, { voucherStatus: "paid", openAmount: 0 }),
    rec(6, { voucherType: "purchasecreditnote", voucherStatus: "open", totalAmount: 20, openAmount: 20 }),
    rec(7, { voucherStatus: "voided" }),
    rec(8, { voucherType: "quotation" }),
  ];

  it("sums only usable open amounts, per direction and status", () => {
    const a = analyzeOpenItems(fleet(), AS_OF);
    expect(a.counts).toMatchObject({ OVERDUE_CONFIRMED: 1, POSSIBLY_OVERDUE: 1, OPEN_CONFIRMED: 3, PAID_CONFIRMED: 1 });
    expect(a.totals.RECEIVABLE.OVERDUE_CONFIRMED.openByCurrency).toEqual([{ currency: "EUR", cents: 30000, items: 1 }]);
    expect(a.totals.RECEIVABLE.POSSIBLY_OVERDUE.openByCurrency).toEqual([{ currency: "EUR", cents: 15000, items: 1 }]);
    expect(a.totals.PAYABLE.OPEN_CONFIRMED).toMatchObject({ items: 2, itemsWithoutUsableAmount: 1, openByCurrency: [{ currency: "EUR", cents: 8000, items: 1 }] });
    expect(a.totals.UNKNOWN.OPEN_CONFIRMED.items).toBe(1); // the credit note: listed, never in receivables/payables
    expect(a.excluded).toEqual({ NON_FINANCIAL: 1, VOIDED: 1, DRAFT: 0 });
  });

  it("orders items most urgent first", () => {
    const statuses = analyzeOpenItems(fleet(), AS_OF).items.map((i) => i.status);
    expect(statuses[0]).toBe("OVERDUE_CONFIRMED");
    expect(statuses[1]).toBe("POSSIBLY_OVERDUE");
    expect(statuses[statuses.length - 1]).toBe("PAID_CONFIRMED");
  });

  it("is deterministic under input permutation", () => {
    const base = analyzeOpenItems(fleet(), AS_OF);
    const random = rng(5);
    for (let i = 0; i < 20; i += 1) expect(analyzeOpenItems(shuffle(fleet(), random), AS_OF)).toEqual(base);
  });

  it("property: never OVERDUE_CONFIRMED without a reliable due date, never PAID_CONFIRMED without paid + 0, totals only usable", () => {
    const random = rng(99);
    const statuses = ["open", "overdue", "paid", "paidoff", "unchecked", "sepadebit", "voided", "draft", "weird"];
    const types = ["purchaseinvoice", "invoice", "salesinvoice", "purchasecreditnote", "downpaymentinvoice", "quotation", "unknowntype"];
    const records: FinanceRecord[] = [];
    for (let n = 1; n <= 300; n += 1) {
      const raw = row(n, {
        voucherType: types[Math.floor(random() * types.length)],
        voucherStatus: statuses[Math.floor(random() * statuses.length)],
        voucherDate: `2026-${random() < 0.5 ? "09" : "10"}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`,
        dueDate: random() < 0.2 ? undefined : `2026-${random() < 0.5 ? "09" : "10"}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`,
        totalAmount: random() < 0.1 ? undefined : Math.round(random() * 1000) / 4,
        openAmount: random() < 0.2 ? undefined : random() < 0.2 ? 0 : Math.round(random() * 1000) / 4,
      });
      let r = fromRow(raw);
      if (random() < 0.2) r = rec(n, raw, paymentTerm);
      if (random() < 0.05) r = rec(n, raw, grossConflict);
      records.push(r);
    }
    const a = analyzeOpenItems(records, AS_OF);
    for (const i of a.items) {
      if (i.status === "OVERDUE_CONFIRMED") {
        expect(i.dueDateReliable).toBe(true);
        expect(i.dueDate !== null && i.dueDate < AS_OF).toBe(true);
      }
      if (i.status === "PAID_CONFIRMED") {
        expect(["paid", "paidoff"]).toContain(i.lexwareStatus);
        expect(i.openCents.value).toBe(0);
      }
      if (i.amountUsable) {
        expect(OPEN_STATES.has(i.status)).toBe(true);
        expect(i.criticalIssues).toEqual([]);
        expect(i.openCents.quality === "STRUCTURED" || i.openCents.quality === "DERIVED").toBe(true);
        expect(i.openCents.value).toBeGreaterThan(0);
      }
    }
    let usableSum = 0;
    for (const dir of ["RECEIVABLE", "PAYABLE", "UNKNOWN"] as const) {
      for (const t of Object.values(a.totals[dir])) usableSum += t.openByCurrency.reduce((s, c) => s + (c.cents ?? 0), 0);
    }
    const expected = a.items.filter((i) => i.amountUsable).reduce((s, i) => s + (i.openCents.value ?? 0), 0);
    expect(usableSum).toBe(expected);
  });
});

describe("review round 1: open items", () => {
  // As after a detail merge with a disagreeing voucher date: PR 1 then rates the due date LEXWARE_FIELD.
  const voucherDateConflict = (r: FinanceRecord): FinanceRecord => ({
    ...r,
    dueDateConfidence: "LEXWARE_FIELD",
    voucherDate: { value: null, quality: "CONFLICT", source: null, reason: "SOURCES_DISAGREE", candidates: [{ source: "voucherlist", value: "2026-09-01" }, { source: "voucher", value: "2026-09-03" }] },
  });

  it("a Lexware due date without a usable voucher date is never confirmed overdue (it may be the default)", () => {
    const missingVoucherDate = item(fromRow(without(row(1, { voucherStatus: "open", dueDate: "2026-10-01" }), "voucherDate")));
    expect(missingVoucherDate.dueDateBasis).toBe("LEXWARE_FIELD");
    expect(missingVoucherDate).toMatchObject({ status: "POSSIBLY_OVERDUE", dueDateReliable: false, daysPastDue: null });
    expect(missingVoucherDate.reasons).toContain("DUE_DATE_BASIS_UNVERIFIABLE");
    const disputed = item(rec(2, { voucherStatus: "open", dueDate: "2026-10-01" }, voucherDateConflict));
    expect(disputed.status).toBe("POSSIBLY_OVERDUE");
    expect(disputed.reasons).toContain("DUE_DATE_BASIS_UNVERIFIABLE");
    const notYetDue = item(fromRow(without(row(3, { voucherStatus: "open", dueDate: "2026-10-30" }), "voucherDate")));
    expect(notYetDue.status).toBe("DUE_DATE_UNRELIABLE");
  });

  it("a stated payment term stays reliable even without a voucher date", () => {
    const i = item(fromRow(without(row(1, { voucherType: "invoice", voucherStatus: "overdue", dueDate: "2026-10-01" }), "voucherDate")), AS_OF);
    expect(i.status).toBe("POSSIBLY_OVERDUE");
    const withTerm = item(rec(2, { voucherType: "invoice", voucherStatus: "overdue", dueDate: "2026-10-01" }, (r) => paymentTerm(voucherDateConflict(r))));
    expect(withTerm).toMatchObject({ status: "OVERDUE_CONFIRMED", daysPastDue: 6 });
  });

  it("a failed payment fetch is a visible reason", () => {
    const i = item(
      rec(1, {}, (r) => ({
        ...r,
        payment: { ...r.payment, availability: "FETCH_FAILED" },
        provenance: { ...r.provenance, payment: "FAILED" },
      })),
    );
    expect(i.paymentInfo).toBe("FETCH_FAILED");
    expect(i.reasons).toContain("PAYMENT_INFO_FETCH_FAILED");
  });

  it("down-payment invoices carry the double-count reason; same-day age is 0; an unusable currency is never totalled", () => {
    expect(item(rec(1, { voucherType: "downpaymentinvoice" })).reasons).toContain("DOWN_PAYMENT_DOUBLE_COUNT_RISK");
    expect(item(rec(2, { voucherDate: AS_OF, dueDate: "2026-10-20" })).ageDays).toBe(0);
    const noCurrency = item(fromRow(without(row(3), "currency")));
    expect(noCurrency.amountUsable).toBe(false);
    expect(noCurrency.reasons).toContain("CURRENCY_NOT_USABLE");
  });

  it("orders items of the same status by due date, items without one last", () => {
    const a = analyzeOpenItems(
      [
        rec(1, { voucherDate: "2026-09-01", dueDate: "2026-10-25" }),
        rec(2, { voucherDate: "2026-09-01", dueDate: "2026-10-20" }),
        rec(3, { voucherDate: "2026-09-01", dueDate: "2026-10-30" }),
      ],
      AS_OF,
    );
    expect(a.items.map((i) => i.dueDate)).toEqual(["2026-10-20", "2026-10-25", "2026-10-30"]);
  });
});

describe("review round 2: open items", () => {
  it("a category is never trusted without a usable status value", () => {
    const i = item(rec(1, { voucherStatus: "paid", openAmount: 0 }, (r) => ({ ...r, status: { value: null, quality: "MISSING", source: "voucherlist", reason: "FIELD_ABSENT" } })));
    expect(i.status).toBe("STATUS_UNKNOWN");
  });
});
