import type { FieldValue, FinanceRecord, IssueCode, Quality, Severity } from "./model.js";

/** Fields whose completeness is reported for every snapshot. */
export const KEY_FIELDS = [
  "voucherNumber",
  "voucherDate",
  "dueDate",
  "currency",
  "grossCents",
  "netCents",
  "taxCents",
  "openCents",
  "contactId",
] as const;
export type KeyField = (typeof KEY_FIELDS)[number];

export type QualityCounts = Record<Quality, number>;

export interface QualitySummary {
  readonly records: number;
  /** EXPENSE or REVENUE records — the ones money figures are built from. */
  readonly financialRecords: number;
  readonly unreviewedRecords: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  /** Records affected per issue code (only codes that occur). */
  readonly issueCounts: Readonly<Partial<Record<IssueCode, number>>>;
  /** Quality distribution of key fields across financial records. */
  readonly fields: Readonly<Record<KeyField, QualityCounts>>;
}

function emptyCounts(): QualityCounts {
  return { STRUCTURED: 0, DERIVED: 0, UNVERIFIED: 0, PLACEHOLDER: 0, CONFLICT: 0, MISSING: 0 };
}

function fieldOf(record: FinanceRecord, key: KeyField): FieldValue<unknown> {
  return key === "contactId" ? record.counterparty.contactId : record[key];
}

/** Deterministic data-quality summary (counts only — no amounts, names or ids). */
export function summarizeQuality(records: ReadonlyArray<FinanceRecord>): QualitySummary {
  const bySeverity: Record<Severity, number> = { INFO: 0, WARNING: 0, CRITICAL: 0 };
  const issueCounts: Partial<Record<IssueCode, number>> = {};
  const fields = Object.fromEntries(KEY_FIELDS.map((k) => [k, emptyCounts()])) as Record<KeyField, QualityCounts>;
  let financialRecords = 0;
  let unreviewedRecords = 0;

  for (const r of records) {
    const codes = new Set<IssueCode>();
    for (const i of r.issues) {
      bySeverity[i.severity] += 1;
      codes.add(i.code);
    }
    for (const c of codes) issueCounts[c] = (issueCounts[c] ?? 0) + 1;
    if (r.kind !== "EXPENSE" && r.kind !== "REVENUE") continue;
    financialRecords += 1;
    if (r.statusCategory === "UNCHECKED") unreviewedRecords += 1;
    for (const k of KEY_FIELDS) fields[k][fieldOf(r, k).quality] += 1;
  }

  return { records: records.length, financialRecords, unreviewedRecords, bySeverity, issueCounts, fields };
}
