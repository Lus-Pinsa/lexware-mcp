/**
 * Synthetic finance records for the intelligence tests. No real business data: invented supplier names
 * ("Testlieferant …"), zero-padded test ids, TEST- voucher numbers, round test amounts.
 *
 * Records are built through the real PR 1 normalizer, so issues and qualities are exactly what production yields.
 */
import type { FinanceRecord } from "../../src/finance/model.js";
import { normalizeVoucherlistRow, recomputeIssues } from "../../src/finance/normalize.js";
import { conflict, missing, structured } from "../../src/finance/values.js";

export const CTX = { fetchedAt: "2026-10-07T06:00:00.000Z", timeZone: "Europe/Berlin" } as const;

/** Synthetic Lexware-style id. */
export const rid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

/** A voucherlist row; days are plain YYYY-MM-DD (business days, no offset ambiguity). */
export function row(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: rid(n),
    voucherType: "purchaseinvoice",
    voucherStatus: "open",
    voucherNumber: `TEST-${String(n).padStart(4, "0")}`,
    voucherDate: "2026-10-01",
    createdDate: "2026-10-01T10:00:00.000+02:00",
    updatedDate: "2026-10-01T10:00:00.000+02:00",
    dueDate: "2026-10-15",
    contactName: "Testlieferant A",
    totalAmount: 100,
    openAmount: 100,
    currency: "EUR",
    archived: false,
    ...overrides,
  };
}

/** Remove keys from a row (absent fields, as Lexware omits them). */
export function without(r: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const copy = { ...r };
  for (const k of keys) delete copy[k];
  return copy;
}

export function fromRow(raw: Record<string, unknown>): FinanceRecord {
  const out = normalizeVoucherlistRow(raw, 0, CTX);
  if ("rejected" in out) throw new Error(`fixture row rejected: ${out.rejected.code}`);
  return out.record;
}

/** Record from a row with overrides, optionally patched (issues are recomputed after the patch). */
export function rec(n: number, overrides: Record<string, unknown> = {}, patch?: (r: FinanceRecord) => FinanceRecord): FinanceRecord {
  const base = fromRow(row(n, overrides));
  return patch ? recomputeIssues(patch(base)) : base;
}

/** Attach file hashes as if the attachments had been inspected. */
export function withHashes(record: FinanceRecord, ...hashes: string[]): FinanceRecord {
  return recomputeIssues({
    ...record,
    attachments: structured(
      hashes.map((sha256, i) => ({
        fileId: `f${i}-${record.id.slice(-6)}`,
        inspection: {
          status: "text_extracted" as const,
          sha256,
          byteLength: 10,
          mimeType: "application/pdf",
          pageCount: 1,
          text: null,
          textTruncated: false,
        },
      })),
      "voucher",
    ),
    provenance: { ...record.provenance, detail: "FETCHED", attachments: "FETCHED" },
  });
}

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);

/** Patches for disputed values. */
export const grossConflict = (r: FinanceRecord): FinanceRecord => ({
  ...r,
  grossCents: conflict([
    { source: "voucherlist", value: 10000 },
    { source: "voucher", value: 12000 },
  ]),
});
export const numberConflict = (r: FinanceRecord): FinanceRecord => ({
  ...r,
  voucherNumber: conflict([
    { source: "voucherlist", value: "TEST-1" },
    { source: "voucher", value: "TEST-2" },
  ]),
});
export const contactConflict = (r: FinanceRecord): FinanceRecord => ({
  ...r,
  counterparty: {
    ...r.counterparty,
    contactId: conflict([
      { source: "voucherlist", value: "00000000-0000-4000-8000-0000000000c1" },
      { source: "voucher", value: "00000000-0000-4000-8000-0000000000c2" },
    ]),
    matchKey: null,
    matchKeyBasis: "NONE",
  },
});
export const openConflict = (r: FinanceRecord): FinanceRecord => ({
  ...r,
  openCents: conflict([
    { source: "voucherlist", value: 10000 },
    { source: "payment", value: 5000 },
  ]),
});
export const dueConflict = (r: FinanceRecord): FinanceRecord => ({
  ...r,
  dueDate: conflict([
    { source: "voucherlist", value: "2026-10-10" },
    { source: "voucher", value: "2026-10-20" },
  ]),
  dueDateConfidence: "MISSING",
});
export const statusConflict = (r: FinanceRecord): FinanceRecord => ({
  ...r,
  status: conflict([
    { source: "voucherlist", value: "open" },
    { source: "voucher", value: "paid" },
  ]),
  statusCategory: "UNKNOWN",
});
export const paymentTerm = (r: FinanceRecord): FinanceRecord => ({ ...r, dueDateConfidence: "PAYMENT_TERM" });
export const paymentNotAvailable = (r: FinanceRecord): FinanceRecord => ({
  ...r,
  payment: {
    availability: "NOT_AVAILABLE",
    paymentStatus: missing("PAYMENT_NOT_AVAILABLE", "payment"),
    paidDate: missing("PAYMENT_NOT_AVAILABLE", "payment"),
    items: missing("PAYMENT_NOT_AVAILABLE", "payment"),
  },
  provenance: { ...r.provenance, payment: "FETCHED" },
});

/** Deterministic pseudo-random generator for property tests. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function shuffle<T>(items: ReadonlyArray<T>, random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
