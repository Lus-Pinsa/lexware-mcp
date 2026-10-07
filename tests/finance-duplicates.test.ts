import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUPLICATE_CONFIG,
  DUPLICATE_RULES,
  analyzeDuplicates,
  classifyPair,
  mergeVerifiedAnalysis,
  normalizeVoucherNumberKey,
  resolveDuplicateConfig,
} from "../src/finance/duplicates.js";
import type { FinanceRecord } from "../src/finance/model.js";
import {
  HASH_A,
  HASH_B,
  contactConflict,
  grossConflict,
  numberConflict,
  rec,
  rid,
  rng,
  row,
  shuffle,
  without,
  fromRow,
  withHashes,
} from "./fixtures/intelligence-fixtures.js";

const CONTACT_1 = "00000000-0000-4000-8000-0000000000c1";
const CONTACT_2 = "00000000-0000-4000-8000-0000000000c2";

describe("duplicate rules (one class per pair, explainable)", () => {
  it("E1: a shared attachment hash is an EXACT_DUPLICATE, even with other differences", () => {
    const a = withHashes(rec(1, { voucherNumber: "TEST-1001", totalAmount: 100 }), HASH_A);
    const b = withHashes(rec(2, { voucherNumber: "TEST-2002", totalAmount: 250, contactName: "Testlieferant B" }), HASH_A, HASH_B);
    const r = classifyPair(a, b);
    expect(r.classification).toBe("EXACT_DUPLICATE");
    expect(r.rule).toBe("E1");
    expect(r.reasonCodes).toContain("SAME_FILE_HASH");
    expect(r.reasonCodes).toContain("AMOUNT_DIFFERS");
    expect(r.recordIds).toEqual([rid(1), rid(2)]);
  });

  it("different hashes alone are no evidence either way (other rules still apply)", () => {
    const a = withHashes(rec(1, { voucherNumber: "TEST-1001" }), HASH_A);
    const b = withHashes(rec(2, { voucherNumber: "TEST-1001" }), HASH_B);
    const r = classifyPair(a, b);
    expect(r.evidence.fileHash).toBe("DIFFERENT");
    expect(r.rule).toBe("E2"); // same supplier name + number + amount + day
  });

  it("E2: same counterparty + number + amount + day is EXACT (name-based and contact-id-based)", () => {
    const byName = classifyPair(rec(1, { voucherNumber: "TEST-1001" }), rec(2, { voucherNumber: "TEST-1001" }));
    expect(byName).toMatchObject({ classification: "EXACT_DUPLICATE", rule: "E2" });
    expect(byName.reasonCodes).toEqual(
      expect.arrayContaining(["SAME_COUNTERPARTY_NAME", "SAME_VOUCHER_NUMBER", "SAME_AMOUNT", "SAME_VOUCHER_DAY"]),
    );
    const byId = classifyPair(
      rec(1, { voucherNumber: "TEST-1001", contactId: CONTACT_1 }),
      rec(2, { voucherNumber: "TEST-1001", contactId: CONTACT_1, contactName: "Testlieferant A GmbH" }),
    );
    expect(byId).toMatchObject({ classification: "EXACT_DUPLICATE", rule: "E2" });
    expect(byId.reasonCodes).toContain("SAME_CONTACT_ID");
  });

  it("P1: same counterparty + number + amount on different days is PROBABLE", () => {
    const r = classifyPair(rec(1, { voucherNumber: "TEST-1001" }), rec(2, { voucherNumber: "TEST-1001", voucherDate: "2026-11-20" }));
    expect(r).toMatchObject({ classification: "PROBABLE_DUPLICATE", rule: "P1" });
    expect(r.reasonCodes).toContain("OUTSIDE_DAY_WINDOW");
  });

  it("S2: same number, different amount is POSSIBLE (correction or entry error), never more", () => {
    const r = classifyPair(rec(1, { voucherNumber: "TEST-1001" }), rec(2, { voucherNumber: "TEST-1001", totalAmount: 120 }));
    expect(r).toMatchObject({ classification: "POSSIBLE_DUPLICATE", rule: "S2" });
    expect(r.reasonCodes).toContain("AMOUNT_DIFFERS");
  });

  it("S2 also covers a missing amount on one side (e.g. an unreviewed inbox copy)", () => {
    const inbox = fromRow(without(row(2, { voucherNumber: "TEST-1001", voucherStatus: "unchecked" }), "totalAmount", "openAmount"));
    const r = classifyPair(rec(1, { voucherNumber: "TEST-1001" }), inbox);
    expect(r).toMatchObject({ classification: "POSSIBLE_DUPLICATE", rule: "S2" });
    expect(r.reasonCodes).toEqual(expect.arrayContaining(["AMOUNT_NOT_COMPARABLE", "UNREVIEWED_INVOLVED"]));
  });

  it("S3: same number + amount within 14 days but another supplier is POSSIBLE (wrong contact assignment)", () => {
    const r = classifyPair(
      rec(1, { voucherNumber: "TEST-1001" }),
      rec(2, { voucherNumber: "TEST-1001", contactName: "Testlieferant B", voucherDate: "2026-10-10" }),
    );
    expect(r).toMatchObject({ classification: "POSSIBLE_DUPLICATE", rule: "S3" });
    expect(r.reasonCodes).toContain("COUNTERPARTY_DIFFERS");
  });

  it("S1: same supplier + amount within 14 days without a number is POSSIBLE", () => {
    const a = fromRow(without(row(1), "voucherNumber"));
    const b = fromRow(without(row(2, { voucherDate: "2026-10-15" }), "voucherNumber"));
    const r = classifyPair(a, b);
    expect(r).toMatchObject({ classification: "POSSIBLE_DUPLICATE", rule: "S1" });
    expect(r.evidence.dayDistance).toBe(14);
    expect(r.reasonCodes).toContain("WITHIN_DAY_WINDOW");
  });

  it("same supplier + amount OUTSIDE the 14-day window is NOT a duplicate", () => {
    const a = fromRow(without(row(1), "voucherNumber"));
    const b = fromRow(without(row(2, { voucherDate: "2026-10-16" }), "voucherNumber"));
    const r = classifyPair(a, b);
    expect(r.classification).toBe("NOT_DUPLICATE");
    expect(r.rule).toBeNull();
    expect(r.evidence).toMatchObject({ dayDistance: 15, voucherDay: "OUTSIDE_WINDOW" });
  });

  it("same supplier + amount within the window but DIFFERENT invoice numbers is not a duplicate (recurring invoices)", () => {
    const r = classifyPair(rec(1, { voucherNumber: "TEST-1001" }), rec(2, { voucherNumber: "TEST-1002", voucherDate: "2026-10-05" }));
    expect(r.classification).toBe("NOT_DUPLICATE");
    expect(r.reasonCodes).toContain("VOUCHER_NUMBER_DIFFERS");
  });

  it("an equal amount alone — another supplier, same day — is never a duplicate", () => {
    const r = classifyPair(
      rec(1, { voucherNumber: "TEST-1001" }),
      rec(2, { voucherNumber: "TEST-2002", contactName: "Testlieferant B" }),
    );
    expect(r.classification).toBe("NOT_DUPLICATE");
    const noKeys = classifyPair(fromRow(without(row(1), "voucherNumber", "contactName")), fromRow(without(row(2), "voucherNumber", "contactName")));
    expect(noKeys.classification).toBe("NOT_DUPLICATE");
    expect(noKeys.evidence).toMatchObject({ amount: "SAME", voucherDay: "SAME_DAY", counterparty: "NOT_COMPARABLE" });
  });

  it("different contact ids are different counterparties even with equal names", () => {
    const r = classifyPair(
      fromRow(without(row(1, { contactId: CONTACT_1 }), "voucherNumber")),
      fromRow(without(row(2, { contactId: CONTACT_2 }), "voucherNumber")),
    );
    expect(r.evidence.counterparty).toBe("DIFFERENT");
    expect(r.classification).toBe("NOT_DUPLICATE");
  });

  it("a contact-id record and a name-only record are compared by normalized name", () => {
    const r = classifyPair(
      rec(1, { voucherNumber: "TEST-1001", contactId: CONTACT_1, contactName: "Testlieferant A GmbH & Co. KG," }),
      rec(2, { voucherNumber: "TEST-1001", contactName: "TESTLIEFERANT A GMBH & CO KG" }),
    );
    expect(r.evidence.counterparty).toBe("SAME_NAME");
    expect(r.rule).toBe("E2");
  });
});

describe("missing values and conflicts are never a match", () => {
  it("a disputed (CONFLICT) amount is not comparable", () => {
    const r = classifyPair(rec(1, { voucherNumber: "TEST-1001" }, grossConflict), rec(2, { voucherNumber: "TEST-1001" }));
    expect(r.evidence.amount).toBe("NOT_COMPARABLE");
    expect(r.rule).toBe("S2");
  });

  it("a disputed voucher number is not comparable", () => {
    const r = classifyPair(rec(1, {}, numberConflict), rec(2, { voucherNumber: "TEST-1" }));
    expect(r.evidence.voucherNumber).toBe("NOT_COMPARABLE");
  });

  it("disputed contact ids make the counterparty not comparable (no grouping by name)", () => {
    const r = classifyPair(rec(1, { voucherNumber: "TEST-1001" }, contactConflict), rec(2, { voucherNumber: "TEST-1001" }));
    expect(r.evidence.counterparty).toBe("NOT_COMPARABLE");
    expect(r.rule).toBe("S3"); // number + amount + same day only
  });

  it("missing voucher dates disable the day-window rules", () => {
    const a = fromRow(without(row(1), "voucherNumber", "voucherDate"));
    const b = fromRow(without(row(2), "voucherNumber"));
    const r = classifyPair(a, b);
    expect(r.evidence.voucherDay).toBe("NOT_COMPARABLE");
    expect(r.classification).toBe("NOT_DUPLICATE");
  });

  it("a zero amount is no evidence", () => {
    const a = fromRow(without(row(1, { totalAmount: 0 }), "voucherNumber"));
    const b = fromRow(without(row(2, { totalAmount: 0 }), "voucherNumber"));
    expect(classifyPair(a, b).evidence.amount).toBe("NOT_COMPARABLE");
  });

  it("amounts in different currencies are not comparable", () => {
    const r = classifyPair(rec(1, { voucherNumber: "TEST-1001" }), rec(2, { voucherNumber: "TEST-1001", currency: "CHF" }));
    expect(r.evidence.amount).toBe("NOT_COMPARABLE");
  });

  it.each([["Rechnung"], ["-"], ["0000"], ["12"], ["A-0"]])("voucher number %j is not distinctive", (n) => {
    expect(normalizeVoucherNumberKey(n)).toBeNull();
  });

  it("voucher numbers are normalized (case, separators, NFKC)", () => {
    expect(normalizeVoucherNumberKey("re-2026/001")).toBe("RE2026001");
    expect(normalizeVoucherNumberKey("RE 2026 001")).toBe("RE2026001");
    expect(normalizeVoucherNumberKey("ＲＥ２０２６００１")).toBe("RE2026001");
  });
});

describe("pairing scope", () => {
  it("credit notes are only compared with credit notes", () => {
    const invoice = rec(1, { voucherNumber: "TEST-1001" });
    const credit = rec(2, { voucherNumber: "TEST-1001", voucherType: "purchasecreditnote" });
    expect(classifyPair(invoice, credit).classification).toBe("NOT_DUPLICATE");
    const credit2 = rec(3, { voucherNumber: "TEST-1001", voucherType: "purchasecreditnote" });
    expect(classifyPair(credit, credit2)).toMatchObject({ classification: "EXACT_DUPLICATE", rule: "E2" });
  });

  it("negative amounts (credit notes as Lexware may report them) compare exactly", () => {
    const a = rec(1, { voucherNumber: "TEST-1001", voucherType: "purchasecreditnote", totalAmount: -50 });
    const b = rec(2, { voucherNumber: "TEST-1001", voucherType: "purchasecreditnote", totalAmount: -50 });
    const c = rec(3, { voucherNumber: "TEST-1001", voucherType: "purchasecreditnote", totalAmount: 50 });
    expect(classifyPair(a, b).evidence.amount).toBe("SAME");
    expect(classifyPair(a, c).evidence.amount).toBe("DIFFERENT");
  });

  it("expenses and revenue never pair; voided, draft and non-financial documents are excluded", () => {
    const expense = rec(1, { voucherNumber: "TEST-1001" });
    const revenue = rec(2, { voucherNumber: "TEST-1001", voucherType: "salesinvoice" });
    expect(classifyPair(expense, revenue).classification).toBe("NOT_DUPLICATE");
    const voided = rec(3, { voucherNumber: "TEST-1001", voucherStatus: "voided" });
    const draft = rec(4, { voucherNumber: "TEST-1001", voucherStatus: "draft" });
    const quotation = rec(5, { voucherNumber: "TEST-1001", voucherType: "quotation" });
    expect(classifyPair(expense, voided).classification).toBe("NOT_DUPLICATE");
    expect(classifyPair(expense, draft).classification).toBe("NOT_DUPLICATE");
    const analysis = analyzeDuplicates([expense, revenue, voided, draft, quotation]);
    expect(analysis.findings).toEqual([]);
    expect(analysis.excluded).toEqual({ NON_FINANCIAL: 1, UNKNOWN_KIND: 0, VOIDED: 1, DRAFT: 1 });
  });

  it("the same Lexware id is the same document, never its own duplicate", () => {
    const a = rec(1, { voucherNumber: "TEST-1001" });
    expect(classifyPair(a, a).classification).toBe("NOT_DUPLICATE");
    const analysis = analyzeDuplicates([a, a, a]);
    expect(analysis.findings).toEqual([]);
    expect(analysis.repeatedIdsDropped).toBe(2);
  });
});

describe("analyzeDuplicates", () => {
  const fleet = (): FinanceRecord[] => [
    rec(1, { voucherNumber: "TEST-1001" }),
    rec(2, { voucherNumber: "TEST-1001" }), // E2 with 1
    rec(3, { voucherNumber: "TEST-1001", voucherDate: "2026-12-01" }), // P1 with 1 and 2
    rec(4, { voucherNumber: "TEST-3003", totalAmount: 77 }),
    rec(5, { voucherNumber: "TEST-5005", contactName: "Testlieferant B" }),
    withHashes(rec(6, { voucherNumber: "TEST-6006", contactName: "Testlieferant C" }), HASH_A),
    withHashes(rec(7, { voucherNumber: "TEST-7007", contactName: "Testlieferant D", totalAmount: 5 }), HASH_A),
  ];

  it("reports findings most severe first with counts", () => {
    const a = analyzeDuplicates(fleet());
    expect(a.counts).toEqual({ EXACT_DUPLICATE: 2, PROBABLE_DUPLICATE: 2, POSSIBLE_DUPLICATE: 0 });
    expect(a.findings.map((f) => [f.rule, ...f.recordIds])).toEqual([
      ["E1", rid(6), rid(7)],
      ["E2", rid(1), rid(2)],
      ["P1", rid(1), rid(3)],
      ["P1", rid(2), rid(3)],
    ]);
    expect(a.complete).toBe(true);
    expect(a.recordsWithFileHash).toBe(2);
  });

  it("is deterministic under input permutation", () => {
    const base = analyzeDuplicates(fleet());
    const random = rng(7);
    for (let i = 0; i < 20; i += 1) expect(analyzeDuplicates(shuffle(fleet(), random))).toEqual(base);
  });

  it("finds exactly the pairs a full pairwise scan finds (blocking loses nothing)", () => {
    const random = rng(11);
    const names = ["Testlieferant A", "Testlieferant B", "testlieferant  a", undefined];
    const records: FinanceRecord[] = [];
    for (let n = 1; n <= 60; n += 1) {
      const raw = row(n, {
        voucherNumber: random() < 0.6 ? `TEST-${100 + Math.floor(random() * 8)}` : undefined,
        totalAmount: [10, 20, 0, 33.33][Math.floor(random() * 4)],
        voucherDate: `2026-10-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`,
        contactName: names[Math.floor(random() * names.length)],
        contactId: random() < 0.2 ? CONTACT_1 : undefined,
        voucherType: random() < 0.85 ? "purchaseinvoice" : "purchasecreditnote",
        voucherStatus: ["open", "paid", "unchecked", "voided"][Math.floor(random() * 4)],
      });
      let r = fromRow(raw);
      if (random() < 0.15) r = withHashes(r, random() < 0.5 ? HASH_A : HASH_B);
      records.push(r);
    }
    const brute: string[] = [];
    for (let i = 0; i < records.length; i += 1) {
      for (let j = i + 1; j < records.length; j += 1) {
        const r = classifyPair(records[i], records[j]);
        if (r.classification !== "NOT_DUPLICATE") brute.push(`${r.rule}|${r.recordIds.join("|")}`);
      }
    }
    const fast = analyzeDuplicates(records).findings.map((f) => `${f.rule}|${f.recordIds.join("|")}`);
    expect(fast.sort()).toEqual(brute.sort());
  });

  it("property: symmetric, one class per pair, never a duplicate from amount (+ day) alone", () => {
    const random = rng(3);
    for (let i = 0; i < 400; i += 1) {
      const mk = (n: number) =>
        fromRow(
          row(n, {
            voucherNumber: random() < 0.5 ? `TEST-${Math.floor(random() * 3)}11` : undefined,
            contactName: random() < 0.5 ? "Testlieferant A" : random() < 0.5 ? "Testlieferant B" : undefined,
            totalAmount: random() < 0.7 ? 50 : 60,
            voucherDate: `2026-10-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`,
          }),
        );
      const a = mk(1);
      const b = mk(2);
      const ab = classifyPair(a, b);
      const ba = classifyPair(b, a);
      expect(ab).toEqual(ba);
      expect(Object.keys(DUPLICATE_RULES).concat("null")).toContain(String(ab.rule));
      const e = ab.evidence;
      if (ab.rule !== null) {
        const keys = [e.fileHash === "SAME", e.voucherNumber === "SAME", e.counterparty.startsWith("SAME")].filter(Boolean).length;
        expect(keys).toBeGreaterThanOrEqual(1);
      }
      if (e.voucherNumber !== "SAME" && !e.counterparty.startsWith("SAME") && e.fileHash !== "SAME") {
        expect(ab.classification).toBe("NOT_DUPLICATE");
      }
    }
  });

  it("stops at the pair limit and says so (never silently)", () => {
    const records = Array.from({ length: 30 }, (_, i) => fromRow(without(row(i + 1), "voucherNumber")));
    const a = analyzeDuplicates(records, { maxPairs: 10 });
    expect(a.complete).toBe(false);
    expect(a.limitReason).toBe("PAIR_LIMIT");
    expect(a.pairsEvaluated).toBe(10);
  });

  it("validates its configuration", () => {
    expect(resolveDuplicateConfig()).toEqual(DEFAULT_DUPLICATE_CONFIG);
    expect(() => resolveDuplicateConfig({ windowDays: -1 })).toThrow(RangeError);
    expect(() => resolveDuplicateConfig({ windowDays: 1.5 })).toThrow(RangeError);
    expect(() => resolveDuplicateConfig({ maxPairs: 0 })).toThrow(RangeError);
    expect(() => resolveDuplicateConfig({ maxPairs: Number.NaN })).toThrow(RangeError);
  });

  it("never mutates its input", () => {
    const records = fleet();
    const before = JSON.stringify(records);
    analyzeDuplicates(records);
    expect(JSON.stringify(records)).toBe(before);
  });
});

describe("review round 1: duplicates", () => {
  it("same number with another supplier AND another amount is not a duplicate; S3 needs the day window", () => {
    expect(classifyPair(rec(1, { voucherNumber: "TEST-1001" }), rec(2, { voucherNumber: "TEST-1001", contactName: "Testlieferant B", totalAmount: 120 })).classification).toBe("NOT_DUPLICATE");
    const far = classifyPair(rec(1, { voucherNumber: "TEST-1001" }), rec(2, { voucherNumber: "TEST-1001", contactName: "Testlieferant B", voucherDate: "2026-11-20" }));
    expect(far.classification).toBe("NOT_DUPLICATE");
    expect(far.reasonCodes).toContain("OUTSIDE_DAY_WINDOW");
  });

  it("the day distance is symmetric (the lower id on the later day)", () => {
    const later = fromRow(without(row(1, { voucherDate: "2026-10-16" }), "voucherNumber"));
    const earlier = fromRow(without(row(2, { voucherDate: "2026-10-01" }), "voucherNumber"));
    const r = classifyPair(later, earlier);
    expect(r.evidence).toMatchObject({ dayDistance: 15, voucherDay: "OUTSIDE_WINDOW" });
    expect(r.classification).toBe("NOT_DUPLICATE");
  });

  it("negative credit-note amounts classify like any amount", () => {
    const a = rec(1, { voucherNumber: "TEST-1001", voucherType: "purchasecreditnote", totalAmount: -50 });
    const b = rec(2, { voucherNumber: "TEST-1001", voucherType: "purchasecreditnote", totalAmount: -50 });
    expect(classifyPair(a, b)).toMatchObject({ classification: "EXACT_DUPLICATE", rule: "E2" });
  });

  it("orders findings by plain code units of the ids (mixed case)", () => {
    const records = ["b-1", "B-1", "a-1"].map((id, i) => rec(10 + i, { id, voucherNumber: "TEST-1001" }));
    expect(analyzeDuplicates(records).findings.map((f) => f.recordIds.join("|"))).toEqual(["B-1|a-1", "B-1|b-1", "a-1|b-1"]);
  });

  it("repeated ids with different content give the same result in any order", () => {
    const x1 = rec(1, { voucherNumber: "TEST-1001" });
    const x2 = rec(1, { voucherNumber: "TEST-1001", totalAmount: 999 });
    const y = rec(2, { voucherNumber: "TEST-1001" });
    expect(analyzeDuplicates([x1, x2, y])).toEqual(analyzeDuplicates([y, x2, x1]));
  });

  it("only well-formed SHA-256 values count as file hashes", () => {
    const a = withHashes(rec(1, { voucherNumber: "TEST-1111" }), "A".repeat(64));
    const b = withHashes(rec(2, { voucherNumber: "TEST-2222", contactName: "Testlieferant B" }), "A".repeat(64));
    expect(classifyPair(a, b).evidence.fileHash).toBe("NOT_COMPARABLE");
  });
});

describe("review round 2: duplicates", () => {
  it("two empty files are no shared file (every empty file has the same SHA-256)", () => {
    const empty = (r: FinanceRecord) => {
      const w = withHashes(r, HASH_A);
      const files = (w.attachments.value ?? []).map((a) => ({ ...a, inspection: a.inspection ? { ...a.inspection, byteLength: 0 } : null }));
      return { ...w, attachments: { ...w.attachments, value: files } } as FinanceRecord;
    };
    const r = classifyPair(empty(rec(1, { voucherNumber: "TEST-1111" })), empty(rec(2, { voucherNumber: "TEST-2222", contactName: "Testlieferant B" })));
    expect(r.evidence.fileHash).toBe("NOT_COMPARABLE");
    expect(r.classification).toBe("NOT_DUPLICATE");
  });

  it("hashes from an attachment list that is not usable (e.g. UNVERIFIED) are ignored", () => {
    const unverified = (r: FinanceRecord) => {
      const w = withHashes(r, HASH_A);
      return { ...w, attachments: { ...w.attachments, quality: "UNVERIFIED" as const } };
    };
    const r = classifyPair(unverified(rec(1, { voucherNumber: "TEST-1111" })), withHashes(rec(2, { voucherNumber: "TEST-2222", contactName: "Testlieferant B" }), HASH_A));
    expect(r.evidence.fileHash).toBe("NOT_COMPARABLE");
  });
});

describe("review round 3: merging a verified analysis", () => {
  it("keeps list-only findings with KEPT_FROM_LIST_ANALYSIS and lets the verified result win for shared pairs", () => {
    const a = rec(1, { voucherNumber: "TEST-1111" });
    const b = rec(2, { voucherNumber: "TEST-1111", totalAmount: 120 });
    const listOnly = analyzeDuplicates([a, b]);
    expect(listOnly.findings[0].rule).toBe("S2");
    const disputed = analyzeDuplicates([a, rec(2, { voucherNumber: "TEST-9999", totalAmount: 120 })]);
    expect(disputed.findings).toEqual([]);
    const merged = mergeVerifiedAnalysis(listOnly, disputed);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0].reasonCodes).toContain("KEPT_FROM_LIST_ANALYSIS");
    expect(merged.counts.POSSIBLE_DUPLICATE).toBe(1);
    const upgraded = analyzeDuplicates([withHashes(a, HASH_A), withHashes(b, HASH_A)]);
    const both = mergeVerifiedAnalysis(listOnly, upgraded);
    expect(both.findings.map((f) => f.rule)).toEqual(["E1"]);
    expect(both.findings[0].reasonCodes).not.toContain("KEPT_FROM_LIST_ANALYSIS");
  });
});

describe("review round 3: defence in depth", () => {
  it("ids containing the old separator cannot hide a pair", () => {
    // Hand-built ids (the normalizer would reject "|"): a|b + c and a + b|c must stay two different pairs.
    const records = ["a|b", "c", "a", "b|c"].map((id, i) => ({ ...rec(i + 1, { voucherNumber: "TEST-1001" }), id }));
    expect(analyzeDuplicates(records).findings).toHaveLength(6);
  });
});
