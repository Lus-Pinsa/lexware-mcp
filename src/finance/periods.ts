/**
 * Reproducible month-to-date / previous-month comparisons and the anomaly rule.
 *
 * - Pure: the reference day (`asOf`) and whether the underlying list was loaded completely are passed in.
 * - Periods are calendar days of the voucher date in the business time zone (see dates.ts).
 * - Money figures are GROSS amounts of reviewed documents only (Lexware status open/overdue/paid or another
 *   known booked status), without CRITICAL issues; everything else is counted as excluded, never estimated.
 * - Lexware invoice revenue is NOT the LU'S point-of-sale revenue (REVENUE_SCOPE_NOTE travels with the result).
 * - Credit notes (sign unverified) and down-payment invoices (double-count risk) are counted, never netted.
 */
import {
  type RelativeChange,
  absoluteChangeAtLeast,
  addCents,
  percentToHundredths,
  relativeChange,
  relativeChangeAtLeast,
  subtractCents,
} from "./amounts.js";
import { type DayRange, inRange, isValidDay, monthEnd, monthStart, previousMonthStart, sameDayPreviousMonth } from "./calendar.js";
import { compareCodeUnits, grossAmount, hasCriticalIssue, isBooked, isFinancial, uniqueById, voucherDay } from "./facts.js";
import { type FinanceRecord, REVENUE_SCOPE_NOTE } from "./model.js";
import { type Direction, OPEN_STATES, classifyOpenItem } from "./open-items.js";
import { isUsable } from "./values.js";

export interface PeriodSet {
  /** First day of the month of `asOf` through `asOf`. */
  readonly current: DayRange;
  /** Same days in the previous month (end clamped to that month's last day). */
  readonly previousSamePeriod: DayRange;
  /** The complete previous month. */
  readonly previousFull: DayRange;
}

export function comparisonPeriods(asOf: string): PeriodSet {
  if (!isValidDay(asOf)) throw new RangeError("asOf must be a valid YYYY-MM-DD day");
  const prevStart = previousMonthStart(asOf);
  return {
    current: { from: monthStart(asOf), to: asOf },
    previousSamePeriod: { from: prevStart, to: sameDayPreviousMonth(asOf) },
    previousFull: { from: prevStart, to: monthEnd(prevStart) },
  };
}

export const MONEY_EXCLUSIONS = ["UNREVIEWED", "STATUS_UNKNOWN", "CRITICAL_ISSUE", "AMOUNT_NOT_USABLE"] as const;
export type MoneyExclusion = (typeof MONEY_EXCLUSIONS)[number];

export interface CurrencySum {
  readonly currency: string;
  /** null when the sum left the safe-integer range (not computable, never rounded). */
  readonly cents: number | null;
  readonly records: number;
}

export interface MoneyMetric {
  /** Documents of this kind in the period (voided and draft documents excluded). */
  readonly documents: number;
  readonly includedRecords: number;
  readonly byCurrency: ReadonlyArray<CurrencySum>;
  readonly excluded: Readonly<Record<MoneyExclusion, number>>;
}

export interface OpenNow {
  readonly items: number;
  readonly itemsWithoutUsableAmount: number;
  readonly byCurrency: ReadonlyArray<CurrencySum>;
}

export interface SupplierTotal {
  readonly matchKey: string;
  /** Sanitized display name from Lexware (untrusted text). */
  readonly name: string | null;
  readonly cents: number | null;
  readonly records: number;
}

export interface SupplierRanking {
  readonly currency: string;
  readonly items: ReadonlyArray<SupplierTotal>;
  readonly suppliers: number;
  /** Included expense records without an identified counterparty. */
  readonly unidentified: { readonly records: number; readonly cents: number | null };
}

export interface CategoryTotal {
  readonly categoryName: string;
  readonly amountBasis: "gross" | "net" | "unknown";
  readonly cents: number | null;
  readonly lines: number;
}

export interface CategoryRanking {
  readonly available: boolean;
  readonly reason: "DETAILS_NOT_LOADED" | null;
  readonly recordsWithDetails: number;
  readonly recordsWithoutDetails: number;
  readonly items: ReadonlyArray<CategoryTotal>;
  readonly linesWithoutCategoryOrAmount: number;
}

export interface PeriodMetrics {
  readonly range: DayRange;
  /** Purchase invoices (incl. unreviewed), voided/draft excluded. */
  readonly purchaseInvoices: { readonly total: number; readonly unreviewed: number };
  readonly salesInvoices: { readonly total: number; readonly unreviewed: number };
  /** Counted but never netted into the money figures. */
  readonly notNetted: { readonly purchaseCreditNotes: number; readonly salesCreditNotes: number; readonly downPaymentInvoices: number };
  readonly voidedOrDraft: number;
  /** Unreviewed financial documents (Lexware document inbox, status "unchecked"). */
  readonly unreviewed: number;
  readonly reliableExpenses: MoneyMetric;
  readonly lexwareInvoiceRevenue: MoneyMetric;
  /** Amounts of this period's documents that are open according to Lexware at fetch time. */
  readonly openNow: Readonly<Record<Exclude<Direction, "UNKNOWN">, OpenNow>>;
  readonly topSuppliers: SupplierRanking;
  readonly topCostCategories: CategoryRanking;
}

export type MoneyMetricName = "reliableExpenses" | "lexwareInvoiceRevenue" | "openReceivablesNow" | "openPayablesNow";
export type CountMetricName = "purchaseInvoices" | "salesInvoices" | "unreviewed";

export interface MoneyComparison {
  readonly metric: MoneyMetricName;
  readonly currency: string;
  readonly current: number | null;
  readonly comparison: number | null;
  readonly absoluteDiff: number | null;
  readonly relative: RelativeChange;
}

export interface CountComparison {
  readonly metric: CountMetricName;
  readonly current: number;
  readonly comparison: number;
  readonly absoluteDiff: number;
  readonly relative: RelativeChange;
}

export type AnomalySubject =
  | { readonly type: "METRIC"; readonly metric: "reliableExpenses" | "lexwareInvoiceRevenue" }
  | { readonly type: "SUPPLIER"; readonly matchKey: string; readonly name: string | null }
  | { readonly type: "SUPPLIERS" };

export interface Anomaly {
  readonly subject: AnomalySubject;
  readonly currency: string;
  readonly current: number;
  readonly comparison: number;
  readonly absoluteDiff: number;
  readonly relativeTenthsOfPercent: number;
}

export interface NotEvaluated {
  readonly subject: AnomalySubject;
  readonly reason:
    | "DATA_INCOMPLETE"
    | "BASE_ZERO"
    | "NOT_COMPUTABLE"
    | "UNREVIEWED_SHARE_TOO_HIGH"
    | "EXCLUDED_DOCUMENTS"
    | "UNASSIGNED_DOCUMENTS";
  /** For SUPPLIERS entries: how many suppliers share this reason. */
  readonly count?: number;
}

export interface AnomalyConfig {
  /** |relative change| must be at least this many percent … */
  readonly minRelativeChangePercent: number;
  /** … and |absolute change| at least this many cents. */
  readonly minAbsoluteChangeCents: number;
  /** The rule is evaluated for this currency only (the absolute threshold is in this currency). */
  readonly currency: string;
  /** Expense/revenue anomalies are not evaluated when more unreviewed documents than this share exist in a period. */
  readonly maxUnreviewedSharePercent: number;
  readonly topSuppliers: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = Object.freeze({
  minRelativeChangePercent: 30,
  minAbsoluteChangeCents: 25_000,
  currency: "EUR",
  maxUnreviewedSharePercent: 10,
  topSuppliers: 5,
});

interface ResolvedConfig extends AnomalyConfig {
  readonly relativeHundredths: number;
  readonly unreviewedHundredths: number;
}

/** `{ ...defaults, ...config }` without letting an explicit `undefined` replace a default. */
function definedOnly<T extends object>(config: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function resolveAnomalyConfig(config: Partial<AnomalyConfig> = {}): ResolvedConfig {
  const c = { ...DEFAULT_ANOMALY_CONFIG, ...definedOnly(config) };
  if (!Number.isSafeInteger(c.minAbsoluteChangeCents) || c.minAbsoluteChangeCents < 0) {
    throw new RangeError("minAbsoluteChangeCents must be a non-negative integer");
  }
  if (typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency)) throw new RangeError("currency must be an ISO code");
  if (!Number.isSafeInteger(c.topSuppliers) || c.topSuppliers < 0 || c.topSuppliers > 50) {
    throw new RangeError("topSuppliers must be an integer between 0 and 50");
  }
  const unreviewedHundredths = percentToHundredths(c.maxUnreviewedSharePercent);
  if (unreviewedHundredths > 10_000) throw new RangeError("maxUnreviewedSharePercent must not exceed 100");
  return { ...c, relativeHundredths: percentToHundredths(c.minRelativeChangePercent), unreviewedHundredths };
}

export interface PeriodComparison {
  readonly asOf: string;
  readonly periods: PeriodSet;
  readonly current: PeriodMetrics;
  readonly previousSamePeriod: PeriodMetrics;
  readonly previousFull: PeriodMetrics;
  readonly vsPreviousSamePeriod: { readonly money: ReadonlyArray<MoneyComparison>; readonly counts: ReadonlyArray<CountComparison> };
  readonly vsPreviousFull: { readonly money: ReadonlyArray<MoneyComparison>; readonly counts: ReadonlyArray<CountComparison> };
  /** Evaluated on current vs previousSamePeriod only (like-for-like days). */
  readonly anomalies: ReadonlyArray<Anomaly>;
  readonly notEvaluated: ReadonlyArray<NotEvaluated>;
  /** False when the Lexware list was not loaded completely: every figure is a lower bound. */
  readonly dataComplete: boolean;
  /** Financial records whose voucher date is missing or disputed (not assignable to any period). */
  readonly unassignedFinancialRecords: number;
  readonly revenueScopeNote: typeof REVENUE_SCOPE_NOTE;
  readonly rule: AnomalyConfig;
}

const isPurchaseInvoice = (r: FinanceRecord) => r.kind === "EXPENSE" && r.role === "INVOICE";
const isSalesInvoice = (r: FinanceRecord) => r.kind === "REVENUE" && r.role === "INVOICE";
const metricPredicate = { reliableExpenses: isPurchaseInvoice, lexwareInvoiceRevenue: isSalesInvoice } as const;
/** Not an inbox, draft or voided document: its amount would count once its period is known. */
const isReviewedDocument = (r: FinanceRecord) =>
  r.statusCategory !== "UNCHECKED" && r.statusCategory !== "VOIDED" && r.statusCategory !== "DRAFT";

function addToCurrency(map: Map<string, { cents: number | null; records: number }>, currency: string, cents: number): void {
  const entry = map.get(currency) ?? { cents: 0, records: 0 };
  entry.cents = entry.cents === null ? null : addCents(entry.cents, cents);
  entry.records += 1;
  map.set(currency, entry);
}

function sortedSums(map: Map<string, { cents: number | null; records: number }>): CurrencySum[] {
  return [...map.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([currency, v]) => ({ currency, cents: v.cents, records: v.records }));
}

function moneyMetric(records: ReadonlyArray<FinanceRecord>, predicate: (r: FinanceRecord) => boolean): { metric: MoneyMetric; included: FinanceRecord[] } {
  const excluded: Record<MoneyExclusion, number> = { UNREVIEWED: 0, STATUS_UNKNOWN: 0, CRITICAL_ISSUE: 0, AMOUNT_NOT_USABLE: 0 };
  const sums = new Map<string, { cents: number | null; records: number }>();
  const included: FinanceRecord[] = [];
  let documents = 0;
  for (const r of records) {
    if (!predicate(r) || r.statusCategory === "VOIDED" || r.statusCategory === "DRAFT") continue;
    documents += 1;
    const gross = grossAmount(r);
    if (r.statusCategory === "UNCHECKED") excluded.UNREVIEWED += 1;
    else if (!isBooked(r)) excluded.STATUS_UNKNOWN += 1;
    else if (hasCriticalIssue(r)) excluded.CRITICAL_ISSUE += 1;
    else if (gross === null) excluded.AMOUNT_NOT_USABLE += 1;
    else {
      addToCurrency(sums, gross.currency, gross.cents);
      included.push(r);
    }
  }
  return { metric: { documents, includedRecords: included.length, byCurrency: sortedSums(sums), excluded }, included };
}

function supplierMap(included: ReadonlyArray<FinanceRecord>, currency: string): {
  map: Map<string, { name: string | null; cents: number | null; records: number }>;
  unidentified: { records: number; cents: number | null };
} {
  const map = new Map<string, { name: string | null; cents: number | null; records: number }>();
  const unidentified = { records: 0, cents: 0 as number | null };
  // `included` is sorted by id, so the display name comes from a deterministic record.
  for (const r of included) {
    const gross = grossAmount(r);
    if (gross === null || gross.currency !== currency) continue;
    const key = r.counterparty.matchKey;
    if (key === null) {
      unidentified.records += 1;
      unidentified.cents = unidentified.cents === null ? null : addCents(unidentified.cents, gross.cents);
      continue;
    }
    const entry = map.get(key) ?? { name: isUsable(r.counterparty.name) ? r.counterparty.name.value : null, cents: 0, records: 0 };
    entry.cents = entry.cents === null ? null : addCents(entry.cents, gross.cents);
    entry.records += 1;
    map.set(key, entry);
  }
  return { map, unidentified };
}

function rankSuppliers(
  supplier: ReturnType<typeof supplierMap>,
  currency: string,
  top: number,
): SupplierRanking {
  const items = [...supplier.map.entries()]
    .map(([matchKey, v]) => ({ matchKey, name: v.name, cents: v.cents, records: v.records }))
    .sort((a, b) => {
      // Overflowed sums (null) rank first: they are the largest by definition and must stay visible.
      if (a.cents !== b.cents) {
        if (a.cents === null) return -1;
        if (b.cents === null) return 1;
        return b.cents - a.cents;
      }
      return compareCodeUnits(a.matchKey, b.matchKey);
    })
    .slice(0, top);
  return { currency, items, suppliers: supplier.map.size, unidentified: supplier.unidentified };
}

function rankCategories(included: ReadonlyArray<FinanceRecord>, currency: string): CategoryRanking {
  let withDetails = 0;
  let withoutDetails = 0;
  let linesWithout = 0;
  const map = new Map<string, CategoryTotal & { cents: number | null }>();
  for (const r of included) {
    const gross = grossAmount(r);
    if (gross === null || gross.currency !== currency) continue;
    const items = r.lineItems.value;
    if (r.provenance.detail !== "FETCHED" || !isUsable(r.lineItems) || items === null) {
      withoutDetails += 1;
      continue;
    }
    withDetails += 1;
    for (const li of items) {
      if (!isUsable(li.amountCents) || !isUsable(li.categoryName)) {
        linesWithout += 1;
        continue;
      }
      const key = `${li.categoryName.value}|${li.amountBasis}`;
      const entry = map.get(key) ?? { categoryName: li.categoryName.value, amountBasis: li.amountBasis, cents: 0, lines: 0 };
      map.set(key, {
        ...entry,
        cents: entry.cents === null ? null : addCents(entry.cents, li.amountCents.value),
        lines: entry.lines + 1,
      });
    }
  }
  if (withDetails === 0) {
    return {
      available: false,
      reason: "DETAILS_NOT_LOADED",
      recordsWithDetails: 0,
      recordsWithoutDetails: withoutDetails,
      items: [],
      linesWithoutCategoryOrAmount: 0,
    };
  }
  const items = [...map.values()]
    .sort((a, b) => {
      if (a.cents !== b.cents) {
        if (a.cents === null) return -1;
        if (b.cents === null) return 1;
        return b.cents - a.cents;
      }
      return compareCodeUnits(a.categoryName, b.categoryName) || compareCodeUnits(a.amountBasis, b.amountBasis);
    })
    .slice(0, 10);
  return {
    available: true,
    reason: null,
    recordsWithDetails: withDetails,
    recordsWithoutDetails: withoutDetails,
    items,
    linesWithoutCategoryOrAmount: linesWithout,
  };
}

function openNow(records: ReadonlyArray<FinanceRecord>, asOf: string): Record<"RECEIVABLE" | "PAYABLE", OpenNow> {
  const acc = {
    RECEIVABLE: { items: 0, without: 0, sums: new Map<string, { cents: number | null; records: number }>() },
    PAYABLE: { items: 0, without: 0, sums: new Map<string, { cents: number | null; records: number }>() },
  };
  for (const r of records) {
    const out = classifyOpenItem(r, asOf);
    if ("excluded" in out) continue;
    const item = out.item;
    if (item.direction === "UNKNOWN" || !OPEN_STATES.has(item.status)) continue;
    const a = acc[item.direction];
    a.items += 1;
    if (!item.amountUsable || item.currency === null || !isUsable(item.openCents)) {
      a.without += 1;
      continue;
    }
    addToCurrency(a.sums, item.currency, item.openCents.value);
  }
  const done = (a: (typeof acc)["RECEIVABLE"]): OpenNow => ({ items: a.items, itemsWithoutUsableAmount: a.without, byCurrency: sortedSums(a.sums) });
  return { RECEIVABLE: done(acc.RECEIVABLE), PAYABLE: done(acc.PAYABLE) };
}

interface MetricsWithInternals {
  readonly metrics: PeriodMetrics;
  readonly suppliers: ReturnType<typeof supplierMap>;
}

function periodMetrics(records: ReadonlyArray<FinanceRecord>, range: DayRange, asOf: string, cfg: ResolvedConfig): MetricsWithInternals {
  const inPeriod = records.filter((r) => {
    const day = voucherDay(r);
    return day !== null && inRange(day, range);
  });
  const countDocs = (p: (r: FinanceRecord) => boolean) => {
    const docs = inPeriod.filter((r) => p(r) && r.statusCategory !== "VOIDED" && r.statusCategory !== "DRAFT");
    return { total: docs.length, unreviewed: docs.filter((r) => r.statusCategory === "UNCHECKED").length };
  };
  const expenses = moneyMetric(inPeriod, isPurchaseInvoice);
  const revenue = moneyMetric(inPeriod, isSalesInvoice);
  const suppliers = supplierMap(expenses.included, cfg.currency);
  const notVoidedOrDraft = (r: FinanceRecord) => r.statusCategory !== "VOIDED" && r.statusCategory !== "DRAFT";
  return {
    suppliers,
    metrics: {
      range,
      purchaseInvoices: countDocs(isPurchaseInvoice),
      salesInvoices: countDocs(isSalesInvoice),
      notNetted: {
        purchaseCreditNotes: inPeriod.filter((r) => r.kind === "EXPENSE" && r.role === "CREDIT_NOTE" && notVoidedOrDraft(r)).length,
        salesCreditNotes: inPeriod.filter((r) => r.kind === "REVENUE" && r.role === "CREDIT_NOTE" && notVoidedOrDraft(r)).length,
        downPaymentInvoices: inPeriod.filter((r) => r.role === "DOWN_PAYMENT_INVOICE" && notVoidedOrDraft(r)).length,
      },
      voidedOrDraft: inPeriod.filter((r) => (isFinancial(r) || r.kind === "UNKNOWN") && !notVoidedOrDraft(r)).length,
      unreviewed: inPeriod.filter((r) => (isFinancial(r) || r.kind === "UNKNOWN") && r.statusCategory === "UNCHECKED").length,
      reliableExpenses: expenses.metric,
      lexwareInvoiceRevenue: revenue.metric,
      openNow: openNow(inPeriod, asOf),
      topSuppliers: rankSuppliers(suppliers, cfg.currency, cfg.topSuppliers),
      topCostCategories: rankCategories(expenses.included, cfg.currency),
    },
  };
}

function sumFor(sums: ReadonlyArray<CurrencySum>, currency: string): number | null {
  const hit = sums.find((s) => s.currency === currency);
  return hit ? hit.cents : 0;
}

function moneyComparisons(cur: PeriodMetrics, cmp: PeriodMetrics): MoneyComparison[] {
  const pairs: Array<[MoneyMetricName, ReadonlyArray<CurrencySum>, ReadonlyArray<CurrencySum>]> = [
    ["reliableExpenses", cur.reliableExpenses.byCurrency, cmp.reliableExpenses.byCurrency],
    ["lexwareInvoiceRevenue", cur.lexwareInvoiceRevenue.byCurrency, cmp.lexwareInvoiceRevenue.byCurrency],
    ["openReceivablesNow", cur.openNow.RECEIVABLE.byCurrency, cmp.openNow.RECEIVABLE.byCurrency],
    ["openPayablesNow", cur.openNow.PAYABLE.byCurrency, cmp.openNow.PAYABLE.byCurrency],
  ];
  const out: MoneyComparison[] = [];
  for (const [metric, a, b] of pairs) {
    const currencies = [...new Set([...a.map((s) => s.currency), ...b.map((s) => s.currency)])].sort(compareCodeUnits);
    for (const currency of currencies) {
      const current = sumFor(a, currency);
      const comparison = sumFor(b, currency);
      const absoluteDiff = current === null || comparison === null ? null : subtractCents(current, comparison);
      const relative: RelativeChange =
        current === null || comparison === null ? { ok: false, reason: "NOT_COMPUTABLE" } : relativeChange(current, comparison);
      out.push({ metric, currency, current, comparison, absoluteDiff, relative });
    }
  }
  return out;
}

function countComparisons(cur: PeriodMetrics, cmp: PeriodMetrics): CountComparison[] {
  const rows: Array<[CountMetricName, number, number]> = [
    ["purchaseInvoices", cur.purchaseInvoices.total, cmp.purchaseInvoices.total],
    ["salesInvoices", cur.salesInvoices.total, cmp.salesInvoices.total],
    ["unreviewed", cur.unreviewed, cmp.unreviewed],
  ];
  return rows.map(([metric, current, comparison]) => ({
    metric,
    current,
    comparison,
    absoluteDiff: current - comparison,
    relative: relativeChange(current, comparison),
  }));
}

/**
 * Reviewed documents that could not be summed (unknown status, CRITICAL issue, unusable amount): their absence would
 * look like a drop (or hide a rise), so the anomaly rule is not applied while any exist.
 */
function excludedReviewed(metric: MoneyMetric): number {
  return metric.excluded.STATUS_UNKNOWN + metric.excluded.CRITICAL_ISSUE + metric.excluded.AMOUNT_NOT_USABLE;
}

/** unreviewed × 100 > share × total, exactly (0 documents never exceed). */
function unreviewedShareExceeds(counts: { total: number; unreviewed: number }, hundredths: number): boolean {
  return counts.total > 0 && BigInt(counts.unreviewed) * 10_000n > BigInt(hundredths) * BigInt(counts.total);
}

function evaluate(
  subject: AnomalySubject,
  current: number | null,
  comparison: number | null,
  cfg: ResolvedConfig,
): { anomaly: Anomaly } | { notEvaluated: NotEvaluated } | null {
  if (current === null || comparison === null) return { notEvaluated: { subject, reason: "NOT_COMPUTABLE" } };
  if (comparison === 0) return { notEvaluated: { subject, reason: "BASE_ZERO" } };
  if (!relativeChangeAtLeast(current, comparison, cfg.relativeHundredths)) return null;
  if (!absoluteChangeAtLeast(current, comparison, cfg.minAbsoluteChangeCents)) return null;
  const rel = relativeChange(current, comparison);
  const absoluteDiff = subtractCents(current, comparison);
  if (!rel.ok || absoluteDiff === null) return { notEvaluated: { subject, reason: "NOT_COMPUTABLE" } };
  return {
    anomaly: { subject, currency: cfg.currency, current, comparison, absoluteDiff, relativeTenthsOfPercent: rel.tenthsOfPercent },
  };
}

/**
 * Compare the current month to date with the previous month (same days and full month) and apply the anomaly
 * rule. `dataComplete` must be false when the Lexware list was not loaded completely.
 */
export function comparePeriods(
  records: ReadonlyArray<FinanceRecord>,
  asOf: string,
  options: { readonly dataComplete: boolean; readonly config?: Partial<AnomalyConfig> },
): PeriodComparison {
  const cfg = resolveAnomalyConfig(options.config);
  const periods = comparisonPeriods(asOf);
  const { records: unique } = uniqueById(records);
  const cur = periodMetrics(unique, periods.current, asOf, cfg);
  const same = periodMetrics(unique, periods.previousSamePeriod, asOf, cfg);
  const full = periodMetrics(unique, periods.previousFull, asOf, cfg);

  const anomalies: Anomaly[] = [];
  const notEvaluated: NotEvaluated[] = [];
  const metricSubjects: Array<{ metric: "reliableExpenses" | "lexwareInvoiceRevenue"; share: "purchaseInvoices" | "salesInvoices" }> = [
    { metric: "reliableExpenses", share: "purchaseInvoices" },
    { metric: "lexwareInvoiceRevenue", share: "salesInvoices" },
  ];
  let suppliersEvaluable = true;
  let suppliersBlockedBy: NotEvaluated["reason"] = "DATA_INCOMPLETE";
  for (const { metric, share } of metricSubjects) {
    const subject: AnomalySubject = { type: "METRIC", metric };
    if (!options.dataComplete) {
      notEvaluated.push({ subject, reason: "DATA_INCOMPLETE" });
      if (metric === "reliableExpenses") {
        suppliersEvaluable = false;
        suppliersBlockedBy = "DATA_INCOMPLETE";
      }
      continue;
    }
    if (
      unreviewedShareExceeds(cur.metrics[share], cfg.unreviewedHundredths) ||
      unreviewedShareExceeds(same.metrics[share], cfg.unreviewedHundredths)
    ) {
      notEvaluated.push({ subject, reason: "UNREVIEWED_SHARE_TOO_HIGH" });
      if (metric === "reliableExpenses") {
        suppliersEvaluable = false;
        suppliersBlockedBy = "UNREVIEWED_SHARE_TOO_HIGH";
      }
      continue;
    }
    // Reviewed documents of this metric without a usable voucher day could belong to either period.
    if (unique.some((r) => metricPredicate[metric](r) && isReviewedDocument(r) && voucherDay(r) === null)) {
      notEvaluated.push({ subject, reason: "UNASSIGNED_DOCUMENTS" });
      if (metric === "reliableExpenses") {
        suppliersEvaluable = false;
        suppliersBlockedBy = "UNASSIGNED_DOCUMENTS";
      }
      continue;
    }
    if (excludedReviewed(cur.metrics[metric]) > 0 || excludedReviewed(same.metrics[metric]) > 0) {
      notEvaluated.push({ subject, reason: "EXCLUDED_DOCUMENTS" });
      if (metric === "reliableExpenses") {
        suppliersEvaluable = false;
        suppliersBlockedBy = "EXCLUDED_DOCUMENTS";
      }
      continue;
    }
    const result = evaluate(
      subject,
      sumFor(cur.metrics[metric].byCurrency, cfg.currency),
      sumFor(same.metrics[metric].byCurrency, cfg.currency),
      cfg,
    );
    if (result && "anomaly" in result) anomalies.push(result.anomaly);
    if (result && "notEvaluated" in result) notEvaluated.push(result.notEvaluated);
  }

  if (suppliersEvaluable) {
    const keys = [...new Set([...cur.suppliers.map.keys(), ...same.suppliers.map.keys()])].sort(compareCodeUnits);
    const supplierAnomalies: Anomaly[] = [];
    const skipped = { BASE_ZERO: 0, NOT_COMPUTABLE: 0 };
    for (const matchKey of keys) {
      const a = cur.suppliers.map.get(matchKey);
      const b = same.suppliers.map.get(matchKey);
      const subject: AnomalySubject = { type: "SUPPLIER", matchKey, name: a?.name ?? b?.name ?? null };
      const result = evaluate(subject, a ? a.cents : 0, b ? b.cents : 0, cfg);
      if (result && "anomaly" in result) supplierAnomalies.push(result.anomaly);
      if (result && "notEvaluated" in result) skipped[result.notEvaluated.reason as keyof typeof skipped] += 1;
    }
    supplierAnomalies.sort((x, y) => {
      const ax = x.absoluteDiff < 0 ? -x.absoluteDiff : x.absoluteDiff;
      const ay = y.absoluteDiff < 0 ? -y.absoluteDiff : y.absoluteDiff;
      if (ax !== ay) return ay - ax;
      const kx = x.subject.type === "SUPPLIER" ? x.subject.matchKey : "";
      const ky = y.subject.type === "SUPPLIER" ? y.subject.matchKey : "";
      return compareCodeUnits(kx, ky);
    });
    anomalies.push(...supplierAnomalies);
    for (const reason of ["BASE_ZERO", "NOT_COMPUTABLE"] as const) {
      if (skipped[reason] > 0) notEvaluated.push({ subject: { type: "SUPPLIERS" }, reason, count: skipped[reason] });
    }
  } else {
    notEvaluated.push({ subject: { type: "SUPPLIERS" }, reason: suppliersBlockedBy });
  }

  return {
    asOf,
    periods,
    current: cur.metrics,
    previousSamePeriod: same.metrics,
    previousFull: full.metrics,
    vsPreviousSamePeriod: { money: moneyComparisons(cur.metrics, same.metrics), counts: countComparisons(cur.metrics, same.metrics) },
    vsPreviousFull: { money: moneyComparisons(cur.metrics, full.metrics), counts: countComparisons(cur.metrics, full.metrics) },
    anomalies,
    notEvaluated,
    dataComplete: options.dataComplete,
    unassignedFinancialRecords: unique.filter((r) => (isFinancial(r) || r.kind === "UNKNOWN") && voucherDay(r) === null).length,
    revenueScopeNote: REVENUE_SCOPE_NOTE,
    rule: {
      minRelativeChangePercent: cfg.minRelativeChangePercent,
      minAbsoluteChangeCents: cfg.minAbsoluteChangeCents,
      currency: cfg.currency,
      maxUnreviewedSharePercent: cfg.maxUnreviewedSharePercent,
      topSuppliers: cfg.topSuppliers,
    },
  };
}
