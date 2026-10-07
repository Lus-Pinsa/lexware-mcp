/**
 * Small, shared record predicates for the finance intelligence modules. Pure; no I/O.
 *
 * They encode the conservative rules every report shares (see ai-company/audit/2026-10-07-phase2-pr2-finance-intelligence.md):
 * only usable (STRUCTURED/DERIVED) values are facts, and records with a CRITICAL issue never enter sums as facts.
 */
import type { FinanceRecord, IssueCode, StatusCategory } from "./model.js";
import { isUsable } from "./values.js";

/** EXPENSE or REVENUE: documents money figures are built from. */
export function isFinancial(record: FinanceRecord): boolean {
  return record.kind === "EXPENSE" || record.kind === "REVENUE";
}

/** True when any issue on the record is CRITICAL (binding PR 1 rule: never summed as a fact). */
export function hasCriticalIssue(record: FinanceRecord): boolean {
  return record.issues.some((i) => i.severity === "CRITICAL");
}

/** Distinct CRITICAL issue codes, sorted. */
export function criticalIssueCodes(record: FinanceRecord): IssueCode[] {
  return [...new Set(record.issues.filter((i) => i.severity === "CRITICAL").map((i) => i.code))].sort();
}

/**
 * Statuses of documents that were reviewed/issued in Lexware: their amounts count as reviewed figures.
 * UNCHECKED (document inbox), DRAFT, VOIDED and UNKNOWN (incl. disagreeing sources) do not.
 */
const BOOKED: ReadonlySet<StatusCategory> = new Set<StatusCategory>(["OPEN", "OVERDUE", "PAID", "OTHER"]);

export function isBooked(record: FinanceRecord): boolean {
  return BOOKED.has(record.statusCategory) && record.status.quality !== "CONFLICT";
}

/** Usable gross amount with its usable currency, or null. */
export function grossAmount(record: FinanceRecord): { cents: number; currency: string } | null {
  if (!isUsable(record.grossCents) || !isUsable(record.currency)) return null;
  return { cents: record.grossCents.value, currency: record.currency.value };
}

/** Usable voucher day, or null. */
export function voucherDay(record: FinanceRecord): string | null {
  return isUsable(record.voucherDate) ? record.voucherDate.value : null;
}

/** Plain code-unit comparison: locale-independent and stable across runtimes. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Records with distinct ids. When the same id occurs more than once, one deterministic copy is kept (the smallest
 * JSON form), so the result does not depend on input order. Returns the number of dropped repeats.
 */
export function uniqueById(records: ReadonlyArray<FinanceRecord>): { records: FinanceRecord[]; repeatsDropped: number } {
  const byId = new Map<string, FinanceRecord[]>();
  for (const record of records) {
    const list = byId.get(record.id);
    if (list) list.push(record);
    else byId.set(record.id, [record]);
  }
  let repeatsDropped = 0;
  const out: FinanceRecord[] = [];
  for (const list of byId.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    // Serialize only repeated ids (records can carry long attachment texts).
    repeatsDropped += list.length - 1;
    let best = list[0];
    let bestJson = JSON.stringify(best);
    for (const candidate of list.slice(1)) {
      const json = JSON.stringify(candidate);
      if (compareCodeUnits(json, bestJson) < 0) {
        best = candidate;
        bestJson = json;
      }
    }
    out.push(best);
  }
  out.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { records: out, repeatsDropped };
}
