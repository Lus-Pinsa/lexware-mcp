/**
 * Reproducible data-quality assessment for finance reports.
 *
 * No score: the grade is derived from concrete, counted findings with documented, configurable thresholds, so
 * the same data always yields the same grade and every grade can be explained by the findings that triggered it.
 *
 * Grades:
 * - POOR:    the Lexware list was not loaded completely, or ≥ poorCriticalSharePercent of the reviewed records
 *            carry a CRITICAL issue.
 * - LIMITED: any reviewed record with a CRITICAL issue, any source conflict or unknown status, any failed fetch,
 *            or a share threshold reached (unreviewed documents, unidentified counterparties, open items without a
 *            reliable due date).
 * - NO_DATA: the list is complete but contains no finance-relevant documents in scope.
 * - GOOD:    none of the above.
 */
import { percentToHundredths } from "./amounts.js";
import { grossAmount, hasCriticalIssue, uniqueById } from "./facts.js";
import type { FinanceRecord, IssueCode } from "./model.js";
import { OPEN_STATES, type OpenItemsAnalysis } from "./open-items.js";
import { isUsable } from "./values.js";

export const DATA_QUALITY_GRADES = ["GOOD", "LIMITED", "POOR", "NO_DATA"] as const;
export type DataQualityGrade = (typeof DATA_QUALITY_GRADES)[number];

export const DATA_QUALITY_FINDINGS = [
  "LIST_INCOMPLETE",
  "ROWS_REJECTED",
  "CRITICAL_RECORDS",
  "SOURCE_CONFLICT",
  "STATUS_UNKNOWN",
  "FETCH_FAILED",
  "UNREVIEWED",
  "COUNTERPARTY_MISSING",
  "DUE_DATE_UNRELIABLE",
  "AMOUNT_MISSING",
  "VOUCHER_DATE_MISSING",
  "DIRECTION_UNCLEAR",
  "PAYMENT_INFO_MISSING",
] as const;
export type DataQualityFindingCode = (typeof DATA_QUALITY_FINDINGS)[number];

export type FindingEffect = "NONE" | "LIMITED" | "POOR";

export interface DataQualityFinding {
  readonly code: DataQualityFindingCode;
  /** Affected records (for LIST_INCOMPLETE and FETCH_FAILED: occurrences). */
  readonly count: number;
  /** The population the count refers to (null where a share is meaningless). */
  readonly of: number | null;
  readonly effect: FindingEffect;
}

export interface DataQualityConfig {
  readonly poorCriticalSharePercent: number;
  readonly limitedUnreviewedSharePercent: number;
  readonly limitedCounterpartyMissingSharePercent: number;
  readonly limitedDueDateUnreliableSharePercent: number;
}

export const DEFAULT_DATA_QUALITY_CONFIG: DataQualityConfig = Object.freeze({
  poorCriticalSharePercent: 10,
  limitedUnreviewedSharePercent: 25,
  limitedCounterpartyMissingSharePercent: 25,
  limitedDueDateUnreliableSharePercent: 50,
});

export interface DataQualityInput {
  readonly records: ReadonlyArray<FinanceRecord>;
  /** False unless the Lexware list was loaded completely. */
  readonly listComplete: boolean;
  /** Failed detail/payment/attachment fetches reported by the loader. */
  readonly fetchFailures: number;
  /** Voucherlist rows the loader had to reject (not an object, invalid id): documents missing from every figure. */
  readonly rejectedRows?: number;
  /** Optional open-items analysis of the same records (for the due-date finding). */
  readonly openItems?: OpenItemsAnalysis;
}

export interface DataQualityReport {
  readonly grade: DataQualityGrade;
  /** Findings whose effect determined the grade, in DATA_QUALITY_FINDINGS order. */
  readonly triggeredBy: ReadonlyArray<DataQualityFindingCode>;
  /** All findings with a non-zero count (and LIST_INCOMPLETE when applicable), in DATA_QUALITY_FINDINGS order. */
  readonly findings: ReadonlyArray<DataQualityFinding>;
  readonly scope: {
    /** Finance-relevant records (expense, revenue, unknown type), voided and draft documents excluded. */
    readonly records: number;
    readonly reviewedRecords: number;
    readonly unreviewedRecords: number;
    readonly openItems: number | null;
  };
  readonly thresholds: DataQualityConfig;
}

const CONFLICT_CODES: ReadonlySet<IssueCode> = new Set<IssueCode>([
  "STATUS_SOURCES_DIFFER",
  "VOUCHER_DATE_SOURCES_DIFFER",
  "FIELD_SOURCES_DIFFER",
  "CURRENCY_SOURCES_DIFFER",
  "GROSS_SOURCES_DIFFER",
  "OPEN_AMOUNT_SOURCES_DIFFER",
  "CONTACT_ID_SOURCES_DIFFER",
]);

/** count × 100 ≥ percent × of, exactly; false for an empty population. */
function shareReached(count: number, of: number, hundredths: number): boolean {
  return of > 0 && count > 0 && BigInt(count) * 10_000n >= BigInt(hundredths) * BigInt(of);
}

export function resolveDataQualityConfig(config: Partial<DataQualityConfig> = {}): DataQualityConfig {
  const defined = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) as Partial<DataQualityConfig>;
  const c: DataQualityConfig = { ...DEFAULT_DATA_QUALITY_CONFIG, ...defined };
  for (const value of [c.poorCriticalSharePercent, c.limitedUnreviewedSharePercent, c.limitedCounterpartyMissingSharePercent, c.limitedDueDateUnreliableSharePercent]) {
    if (percentToHundredths(value) > 10_000) throw new RangeError("data-quality thresholds must be between 0 and 100");
  }
  return c;
}

export function assessDataQuality(input: DataQualityInput, config: Partial<DataQualityConfig> = {}): DataQualityReport {
  const cfg = resolveDataQualityConfig(config);
  if (!Number.isSafeInteger(input.fetchFailures) || input.fetchFailures < 0) throw new RangeError("fetchFailures must be a non-negative integer");
  const rejectedRows = input.rejectedRows ?? 0;
  if (!Number.isSafeInteger(rejectedRows) || rejectedRows < 0) throw new RangeError("rejectedRows must be a non-negative integer");
  const inScope = uniqueById(input.records).records.filter(
    (r) => (r.kind === "EXPENSE" || r.kind === "REVENUE" || r.kind === "UNKNOWN") && r.statusCategory !== "VOIDED" && r.statusCategory !== "DRAFT",
  );
  const reviewed = inScope.filter((r) => r.statusCategory !== "UNCHECKED");
  const unreviewed = inScope.length - reviewed.length;

  const critical = reviewed.filter(hasCriticalIssue).length;
  const conflicts = inScope.filter((r) => r.issues.some((i) => CONFLICT_CODES.has(i.code))).length;
  const statusUnknown = inScope.filter((r) => r.statusCategory === "UNKNOWN").length;
  const counterpartyMissing = inScope.filter((r) => r.counterparty.matchKeyBasis === "NONE").length;
  // Gross or currency unusable: the same documents the period figures exclude as AMOUNT_NOT_USABLE.
  const amountMissing = inScope.filter((r) => grossAmount(r) === null).length;
  const reviewedAmountMissing = reviewed.filter((r) => grossAmount(r) === null).length;
  const dateMissing = inScope.filter((r) => !isUsable(r.voucherDate)).length;
  const directionUnclear = inScope.filter((r) => r.kind === "UNKNOWN" || r.role === "CREDIT_NOTE").length;
  const paymentMissing = inScope.filter((r) => r.payment.availability === "NOT_AVAILABLE").length;
  const failedProvenance = inScope.filter(
    (r) => r.provenance.detail === "FAILED" || r.provenance.payment === "FAILED" || r.provenance.attachments === "FAILED",
  ).length;
  const fetchFailures = Math.max(input.fetchFailures, failedProvenance);

  let openItems: number | null = null;
  let dueUnreliable = 0;
  if (input.openItems) {
    const open = input.openItems.items.filter((i) => OPEN_STATES.has(i.status));
    openItems = open.length;
    dueUnreliable = open.filter((i) => !i.dueDateReliable).length;
  }

  const findings: DataQualityFinding[] = [];
  const add = (code: DataQualityFindingCode, count: number, of: number | null, effect: FindingEffect) => {
    if (count > 0) findings.push({ code, count, of, effect });
  };
  if (!input.listComplete) findings.push({ code: "LIST_INCOMPLETE", count: 1, of: null, effect: "POOR" });
  add("ROWS_REJECTED", rejectedRows, null, "LIMITED");
  add(
    "CRITICAL_RECORDS",
    critical,
    reviewed.length,
    shareReached(critical, reviewed.length, percentToHundredths(cfg.poorCriticalSharePercent)) ? "POOR" : "LIMITED",
  );
  add("SOURCE_CONFLICT", conflicts, inScope.length, "LIMITED");
  add("STATUS_UNKNOWN", statusUnknown, inScope.length, "LIMITED");
  add("FETCH_FAILED", fetchFailures, null, "LIMITED");
  add(
    "UNREVIEWED",
    unreviewed,
    inScope.length,
    shareReached(unreviewed, inScope.length, percentToHundredths(cfg.limitedUnreviewedSharePercent)) ? "LIMITED" : "NONE",
  );
  add(
    "COUNTERPARTY_MISSING",
    counterpartyMissing,
    inScope.length,
    shareReached(counterpartyMissing, inScope.length, percentToHundredths(cfg.limitedCounterpartyMissingSharePercent)) ? "LIMITED" : "NONE",
  );
  if (openItems !== null) {
    add(
      "DUE_DATE_UNRELIABLE",
      dueUnreliable,
      openItems,
      shareReached(dueUnreliable, openItems, percentToHundredths(cfg.limitedDueDateUnreliableSharePercent)) ? "LIMITED" : "NONE",
    );
  }
  add("AMOUNT_MISSING", amountMissing, inScope.length, reviewedAmountMissing > 0 ? "LIMITED" : "NONE");
  add("VOUCHER_DATE_MISSING", dateMissing, inScope.length, "NONE");
  add("DIRECTION_UNCLEAR", directionUnclear, inScope.length, "NONE");
  add("PAYMENT_INFO_MISSING", paymentMissing, inScope.length, "NONE");

  const order = (code: DataQualityFindingCode) => DATA_QUALITY_FINDINGS.indexOf(code);
  findings.sort((a, b) => order(a.code) - order(b.code));
  const poor = findings.filter((f) => f.effect === "POOR").map((f) => f.code);
  const limited = findings.filter((f) => f.effect === "LIMITED").map((f) => f.code);

  let grade: DataQualityGrade;
  let triggeredBy: DataQualityFindingCode[];
  if (poor.length > 0) {
    grade = "POOR";
    triggeredBy = poor;
  } else if (inScope.length === 0) {
    grade = "NO_DATA";
    triggeredBy = [];
  } else if (limited.length > 0) {
    grade = "LIMITED";
    triggeredBy = limited;
  } else {
    grade = "GOOD";
    triggeredBy = [];
  }

  return {
    grade,
    triggeredBy,
    findings,
    scope: { records: inScope.length, reviewedRecords: reviewed.length, unreviewedRecords: unreviewed, openItems },
    thresholds: {
      poorCriticalSharePercent: cfg.poorCriticalSharePercent,
      limitedUnreviewedSharePercent: cfg.limitedUnreviewedSharePercent,
      limitedCounterpartyMissingSharePercent: cfg.limitedCounterpartyMissingSharePercent,
      limitedDueDateUnreliableSharePercent: cfg.limitedDueDateUnreliableSharePercent,
    },
  };
}
