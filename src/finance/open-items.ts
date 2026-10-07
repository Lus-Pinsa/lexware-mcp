/**
 * Conservative open-items assessment (receivables / payables) over canonical finance records.
 *
 * - Pure: the reference day (`asOf`) is passed in; no clock.
 * - "Overdue" is only confirmed when the due date is reliable (stated payment term, or a Lexware due date that
 *   differs from the voucher date). A due date equal to the voucher date without a payment term is often a
 *   default, so such items are at most POSSIBLY_OVERDUE — never claimed overdue.
 * - Lexware's open amount is used as reported; contradictions (open amount 0 on an "open" document, > 0 on a
 *   "paid" one, negative, larger than the gross amount) are surfaced, never resolved.
 * - Credit notes and unknown voucher types have an unverified direction and never enter receivable/payable sums.
 * - Totals contain only usable open amounts of records without CRITICAL issues (binding PR 1 rule).
 */
import { addCents } from "./amounts.js";
import { daysBetween, isValidDay } from "./calendar.js";
import { compareCodeUnits, criticalIssueCodes, isFinancial, uniqueById } from "./facts.js";
import type { DocumentRole, DueDateConfidence, FieldValue, FinanceRecord, IssueCode } from "./model.js";
import { isUsable } from "./values.js";

export const OPEN_ITEM_STATUSES = [
  "OVERDUE_CONFIRMED",
  "POSSIBLY_OVERDUE",
  "DUE_DATE_UNRELIABLE",
  "OPEN_CONFIRMED",
  "STATUS_UNKNOWN",
  "PAID_CONFIRMED",
] as const;
export type OpenItemStatus = (typeof OPEN_ITEM_STATUSES)[number];

/** Statuses of documents that are open according to Lexware (the amount may still be unusable). */
export const OPEN_STATES: ReadonlySet<OpenItemStatus> = new Set<OpenItemStatus>([
  "OVERDUE_CONFIRMED",
  "POSSIBLY_OVERDUE",
  "DUE_DATE_UNRELIABLE",
  "OPEN_CONFIRMED",
]);

export type Direction = "RECEIVABLE" | "PAYABLE" | "UNKNOWN";

export const OPEN_ITEM_REASONS = [
  "DUE_DATE_POSSIBLE_DEFAULT",
  "DUE_DATE_MISSING",
  "DUE_DATE_CONFLICT",
  "LEXWARE_STATUS_OVERDUE_NOT_CONFIRMED",
  "OPEN_AMOUNT_MISSING",
  "OPEN_AMOUNT_CONFLICT",
  "OPEN_AMOUNT_ZERO_WHILE_OPEN",
  "OPEN_AMOUNT_POSITIVE_WHILE_PAID",
  "OPEN_AMOUNT_NEGATIVE",
  "OPEN_AMOUNT_EXCEEDS_GROSS",
  "CURRENCY_NOT_USABLE",
  "PARTIALLY_PAID",
  "STATUS_UNCHECKED",
  "STATUS_MEANING_UNVERIFIED",
  "STATUS_UNKNOWN",
  "STATUS_CONFLICT",
  "DIRECTION_UNVERIFIED_CREDIT_NOTE",
  "DIRECTION_UNKNOWN_VOUCHER_TYPE",
  "DOWN_PAYMENT_DOUBLE_COUNT_RISK",
  "PAYMENT_INFO_NOT_AVAILABLE",
  "PAYMENT_INFO_FETCH_FAILED",
  "CRITICAL_DATA_ISSUE",
  "VOUCHER_DATE_IN_FUTURE",
] as const;
export type OpenItemReason = (typeof OPEN_ITEM_REASONS)[number];

export interface OpenItem {
  readonly recordId: string;
  readonly voucherType: string;
  readonly role: DocumentRole;
  readonly direction: Direction;
  readonly status: OpenItemStatus;
  readonly lexwareStatus: string | null;
  readonly voucherNumber: string | null;
  readonly voucherDate: string | null;
  readonly counterpartyName: string | null;
  readonly currency: string | null;
  readonly grossCents: FieldValue<number>;
  readonly openCents: FieldValue<number>;
  readonly dueDate: string | null;
  readonly dueDateBasis: DueDateConfidence;
  readonly dueDateReliable: boolean;
  /** Days since the voucher date (only when the voucher date is usable and not in the future). */
  readonly ageDays: number | null;
  /** Days past a reliable due date (OVERDUE_CONFIRMED only). */
  readonly daysPastDue: number | null;
  /** True when `openCents` may enter totals (usable, positive, plausible, no CRITICAL issue). */
  readonly amountUsable: boolean;
  readonly paymentInfo: "NOT_CHECKED" | "AVAILABLE" | "NOT_AVAILABLE" | "FETCH_FAILED" | "SKIPPED";
  readonly reasons: ReadonlyArray<OpenItemReason>;
  readonly criticalIssues: ReadonlyArray<IssueCode>;
}

function directionOf(record: FinanceRecord): { direction: Direction; reason?: OpenItemReason } {
  if (record.role === "CREDIT_NOTE") return { direction: "UNKNOWN", reason: "DIRECTION_UNVERIFIED_CREDIT_NOTE" };
  if (record.kind === "EXPENSE") return { direction: "PAYABLE" };
  if (record.kind === "REVENUE") return { direction: "RECEIVABLE" };
  return { direction: "UNKNOWN", reason: "DIRECTION_UNKNOWN_VOUCHER_TYPE" };
}

function dueReliable(record: FinanceRecord): boolean {
  return isUsable(record.dueDate) && (record.dueDateConfidence === "PAYMENT_TERM" || record.dueDateConfidence === "LEXWARE_FIELD");
}

export type OpenItemExclusion = "NON_FINANCIAL" | "VOIDED" | "DRAFT";

/**
 * Classify one record. Returns `{ excluded }` for non-financial, voided and draft documents (they are no open items
 * and are only counted). `asOf` is the reference calendar day (YYYY-MM-DD) in the business time zone.
 */
export function classifyOpenItem(record: FinanceRecord, asOf: string): { item: OpenItem } | { excluded: OpenItemExclusion } {
  if (!isValidDay(asOf)) throw new RangeError("asOf must be a valid YYYY-MM-DD day");
  if (record.kind === "NON_FINANCIAL") return { excluded: "NON_FINANCIAL" };
  if (record.statusCategory === "VOIDED") return { excluded: "VOIDED" };
  if (record.statusCategory === "DRAFT") return { excluded: "DRAFT" };

  const reasons = new Set<OpenItemReason>();
  const { direction, reason: directionReason } = directionOf(record);
  if (directionReason) reasons.add(directionReason);
  if (record.role === "DOWN_PAYMENT_INVOICE") reasons.add("DOWN_PAYMENT_DOUBLE_COUNT_RISK");

  const open = record.openCents;
  const openValue = isUsable(open) ? open.value : null;
  if (open.quality === "CONFLICT") reasons.add("OPEN_AMOUNT_CONFLICT");
  const currencyUsable = isUsable(record.currency);
  const reliable = dueReliable(record);
  const dueDay = isUsable(record.dueDate) ? record.dueDate.value : null;
  let status: OpenItemStatus;
  let daysPastDue: number | null = null;

  switch (record.statusCategory) {
    case "UNCHECKED":
      status = "STATUS_UNKNOWN";
      reasons.add("STATUS_UNCHECKED");
      break;
    case "OTHER":
      status = "STATUS_UNKNOWN";
      reasons.add("STATUS_MEANING_UNVERIFIED");
      break;
    case "UNKNOWN":
      status = "STATUS_UNKNOWN";
      reasons.add(record.status.quality === "CONFLICT" ? "STATUS_CONFLICT" : "STATUS_UNKNOWN");
      break;
    case "PAID":
      if (openValue === 0) {
        status = "PAID_CONFIRMED";
      } else {
        status = "STATUS_UNKNOWN";
        if (openValue === null) reasons.add(open.quality === "CONFLICT" ? "OPEN_AMOUNT_CONFLICT" : "OPEN_AMOUNT_MISSING");
        else reasons.add(openValue > 0 ? "OPEN_AMOUNT_POSITIVE_WHILE_PAID" : "OPEN_AMOUNT_NEGATIVE");
      }
      break;
    default: {
      // OPEN or OVERDUE according to Lexware.
      if (openValue !== null && openValue <= 0) {
        status = "STATUS_UNKNOWN";
        reasons.add(openValue === 0 ? "OPEN_AMOUNT_ZERO_WHILE_OPEN" : "OPEN_AMOUNT_NEGATIVE");
        break;
      }
      if (openValue === null && open.quality !== "CONFLICT") reasons.add("OPEN_AMOUNT_MISSING");
      const lexwareSaysOverdue = record.statusCategory === "OVERDUE";
      if (reliable && dueDay !== null) {
        if (dueDay < asOf) {
          status = "OVERDUE_CONFIRMED";
          daysPastDue = daysBetween(dueDay, asOf);
        } else if (lexwareSaysOverdue) {
          status = "POSSIBLY_OVERDUE";
          reasons.add("LEXWARE_STATUS_OVERDUE_NOT_CONFIRMED");
        } else {
          status = "OPEN_CONFIRMED";
        }
      } else if (record.dueDateConfidence === "POSSIBLE_DEFAULT" && dueDay !== null) {
        reasons.add("DUE_DATE_POSSIBLE_DEFAULT");
        if (dueDay < asOf) status = "POSSIBLY_OVERDUE";
        else status = "DUE_DATE_UNRELIABLE";
        if (lexwareSaysOverdue) reasons.add("LEXWARE_STATUS_OVERDUE_NOT_CONFIRMED");
      } else {
        reasons.add(record.dueDate.quality === "CONFLICT" ? "DUE_DATE_CONFLICT" : "DUE_DATE_MISSING");
        if (lexwareSaysOverdue) {
          status = "POSSIBLY_OVERDUE";
          reasons.add("LEXWARE_STATUS_OVERDUE_NOT_CONFIRMED");
        } else {
          status = "DUE_DATE_UNRELIABLE";
        }
      }
    }
  }

  const gross = record.grossCents;
  let plausible = true;
  // Only documents that are open according to Lexware can be partially paid or carry an implausible open amount.
  if (OPEN_STATES.has(status) && openValue !== null && openValue > 0 && isUsable(gross)) {
    if (openValue > gross.value) {
      reasons.add("OPEN_AMOUNT_EXCEEDS_GROSS");
      plausible = false;
    } else if (openValue < gross.value) {
      reasons.add("PARTIALLY_PAID");
    }
  }
  if (!currencyUsable) reasons.add("CURRENCY_NOT_USABLE");
  const critical = criticalIssueCodes(record);
  if (critical.length > 0) reasons.add("CRITICAL_DATA_ISSUE");
  if (record.payment.availability === "NOT_AVAILABLE") reasons.add("PAYMENT_INFO_NOT_AVAILABLE");
  if (record.payment.availability === "FETCH_FAILED") reasons.add("PAYMENT_INFO_FETCH_FAILED");

  const voucherDay = isUsable(record.voucherDate) ? record.voucherDate.value : null;
  let ageDays: number | null = null;
  if (voucherDay !== null) {
    const age = daysBetween(voucherDay, asOf);
    if (age >= 0) ageDays = age;
    else reasons.add("VOUCHER_DATE_IN_FUTURE");
  }

  const amountUsable =
    OPEN_STATES.has(status) && openValue !== null && openValue > 0 && plausible && currencyUsable && critical.length === 0;

  return {
    item: {
      recordId: record.id,
      voucherType: record.voucherType,
      role: record.role,
      direction,
      status,
      lexwareStatus: isUsable(record.status) ? record.status.value : null,
      voucherNumber: isUsable(record.voucherNumber) ? record.voucherNumber.value : null,
      voucherDate: voucherDay,
      counterpartyName: isUsable(record.counterparty.name) ? record.counterparty.name.value : null,
      currency: currencyUsable ? (record.currency.value as string) : null,
      grossCents: gross,
      openCents: open,
      dueDate: dueDay,
      dueDateBasis: record.dueDateConfidence,
      dueDateReliable: reliable,
      ageDays,
      daysPastDue,
      amountUsable,
      paymentInfo: record.payment.availability === "NOT_FETCHED" ? "NOT_CHECKED" : record.payment.availability,
      reasons: OPEN_ITEM_REASONS.filter((r) => reasons.has(r)),
      criticalIssues: critical,
    },
  };
}

export interface StatusTotal {
  readonly items: number;
  /** Items whose open amount is not usable for totals (counted, never summed). */
  readonly itemsWithoutUsableAmount: number;
  /** Sum of usable open amounts per currency; null cents when the sum overflowed. */
  readonly openByCurrency: ReadonlyArray<{ readonly currency: string; readonly cents: number | null; readonly items: number }>;
}

export interface OpenItemsAnalysis {
  readonly asOf: string;
  /** Classified items, most urgent first (overdue, possibly overdue, unreliable due date, open, unknown, paid). */
  readonly items: ReadonlyArray<OpenItem>;
  readonly totals: Readonly<Record<Direction, Readonly<Record<OpenItemStatus, StatusTotal>>>>;
  readonly counts: Readonly<Record<OpenItemStatus, number>>;
  readonly excluded: Readonly<Record<OpenItemExclusion, number>>;
  readonly repeatedIdsDropped: number;
}

const STATUS_RANK: Readonly<Record<OpenItemStatus, number>> = Object.fromEntries(
  OPEN_ITEM_STATUSES.map((s, i) => [s, i]),
) as Record<OpenItemStatus, number>;
const DIRECTIONS: ReadonlyArray<Direction> = ["RECEIVABLE", "PAYABLE", "UNKNOWN"];

/** Earlier due days first; items without a due day last. */
function compareDueDays(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareCodeUnits(a, b);
}

function emptyTotals(): Record<OpenItemStatus, { items: number; without: number; byCurrency: Map<string, { cents: number | null; items: number }> }> {
  return Object.fromEntries(
    OPEN_ITEM_STATUSES.map((s) => [s, { items: 0, without: 0, byCurrency: new Map<string, { cents: number | null; items: number }>() }]),
  ) as Record<OpenItemStatus, { items: number; without: number; byCurrency: Map<string, { cents: number | null; items: number }> }>;
}

/** Classify all records and build totals. Deterministic: independent of input order. */
export function analyzeOpenItems(records: ReadonlyArray<FinanceRecord>, asOf: string): OpenItemsAnalysis {
  if (!isValidDay(asOf)) throw new RangeError("asOf must be a valid YYYY-MM-DD day");
  const { records: unique, repeatsDropped } = uniqueById(records);
  const excluded = { NON_FINANCIAL: 0, VOIDED: 0, DRAFT: 0 };
  const items: OpenItem[] = [];
  for (const record of unique) {
    if (!isFinancial(record) && record.kind !== "UNKNOWN") {
      excluded.NON_FINANCIAL += 1;
      continue;
    }
    const out = classifyOpenItem(record, asOf);
    if ("excluded" in out) excluded[out.excluded] += 1;
    else items.push(out.item);
  }

  items.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction) ||
      compareDueDays(a.dueDate, b.dueDate) ||
      compareCodeUnits(a.recordId, b.recordId),
  );

  const raw = Object.fromEntries(DIRECTIONS.map((d) => [d, emptyTotals()])) as Record<Direction, ReturnType<typeof emptyTotals>>;
  const counts = Object.fromEntries(OPEN_ITEM_STATUSES.map((s) => [s, 0])) as Record<OpenItemStatus, number>;
  for (const item of items) {
    counts[item.status] += 1;
    const t = raw[item.direction][item.status];
    t.items += 1;
    if (!item.amountUsable || item.currency === null || !isUsable(item.openCents)) {
      t.without += 1;
      continue;
    }
    const entry = t.byCurrency.get(item.currency) ?? { cents: 0, items: 0 };
    entry.cents = entry.cents === null ? null : addCents(entry.cents, item.openCents.value);
    entry.items += 1;
    t.byCurrency.set(item.currency, entry);
  }

  const totals = Object.fromEntries(
    DIRECTIONS.map((d) => [
      d,
      Object.fromEntries(
        OPEN_ITEM_STATUSES.map((s) => {
          const t = raw[d][s];
          const openByCurrency = [...t.byCurrency.entries()]
            .sort(([a], [b]) => compareCodeUnits(a, b))
            .map(([currency, v]) => ({ currency, cents: v.cents, items: v.items }));
          return [s, { items: t.items, itemsWithoutUsableAmount: t.without, openByCurrency }];
        }),
      ),
    ]),
  ) as unknown as OpenItemsAnalysis["totals"];

  return { asOf, items, totals, counts, excluded, repeatedIdsDropped: repeatsDropped };
}
