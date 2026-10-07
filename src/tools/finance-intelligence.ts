import type { McpServer } from "skybridge/server";
import { z } from "zod";

import { buildDailyBrief } from "../finance/brief.js";
import { addDays, daysBetween, isValidDay, previousMonthStart } from "../finance/calendar.js";
import { assessDataQuality } from "../finance/data-quality.js";
import { dayInTimeZone } from "../finance/dates.js";
import { analyzeDuplicates, mergeVerifiedAnalysis } from "../finance/duplicates.js";
import { type Completeness, type FinanceSnapshot, type LoadOptions, loadFinanceSnapshot } from "../finance/loader.js";
import { DEFAULT_TIME_ZONE, type FieldValue, type FinanceRecord, REVENUE_SCOPE_NOTE } from "../finance/model.js";
import { analyzeOpenItems } from "../finance/open-items.js";
import { comparePeriods, resolveAnomalyConfig } from "../finance/periods.js";
import type { LexwareClient } from "../lexware/client.js";
import type { PdfTextExtractor } from "../lexware/file-inspection.js";
import { createReadOnlyLexwareClient } from "../lexware/read-only-client.js";
import { jsonBool, jsonNum } from "./schemas.js";
import { RO, objectResult, text } from "./shared.js";

/**
 * LU'S finance intelligence (Phase 2, PR 2): five READ-tier tools on top of the canonical finance model.
 *
 * - They read Lexware only through the GET-only facade (no write method is reachable) and keep no server state.
 * - The business logic lives in pure modules under src/finance (duplicates, open items, periods, data quality,
 *   brief); these tools only load data within a request budget and present the results.
 * - Default loads read the voucher list only; detail requests are targeted (open sales documents for due-date
 *   reliability, duplicate candidates for file-hash verification).
 */

export interface FinanceToolDeps {
  /** Clock for the reference day and fetch time (tests inject a fixed one). */
  readonly now?: () => Date;
  /** PDF extractor for hash verification (tests inject a fake). */
  readonly extractor?: PdfTextExtractor;
}

const DEFAULT_TOOL_MAX_REQUESTS = 120;
const MAX_TOOL_REQUESTS = 500;
/** Maximum distance between from and to (an inclusive window therefore spans at most 732 days). */
const MAX_WINDOW_DAYS = 731;
/** Earliest accepted day: older data is not Lexware Office data, and very small years confuse Date arithmetic. */
const MIN_DAY = "2000-01-01";
/** Duplicate candidates whose attachments are hashed in one call (each download is up to 10 MiB). */
const MAX_HASH_CANDIDATES = 25;
/** Requests the hash check may spend: one detail plus on average three files per candidate (and categories). */
const MAX_HASH_REQUESTS = 1 + MAX_HASH_CANDIDATES * 4;
const DEFAULT_MAX_FINDINGS = 100;
const MAX_ANOMALIES_LISTED = 50;

const dayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const maxRequestsParam = jsonNum(z.number().int().min(1).max(MAX_TOOL_REQUESTS))
  .optional()
  .describe(`Maximum Lexware requests for this call (default ${DEFAULT_TOOL_MAX_REQUESTS}, max ${MAX_TOOL_REQUESTS}). Lexware allows about 2 requests per second.`);

class InputError extends Error {}

function errorResult(message: string) {
  return { isError: true, content: text(message) };
}

function requireWindow(from: string, to: string): void {
  if (!isValidDay(from) || !isValidDay(to)) throw new InputError("from/to must be valid YYYY-MM-DD days");
  if (from < MIN_DAY) throw new InputError(`from must not be before ${MIN_DAY}`);
  if (from > to) throw new InputError("from must not be after to");
  if (daysBetween(from, to) > MAX_WINDOW_DAYS) throw new InputError(`the window must not exceed ${MAX_WINDOW_DAYS} days`);
}

function fetchFailures(c: Completeness): number {
  return c.details.failed + c.payments.failed + c.attachments.failed;
}

/** Load metadata every tool reports (no amounts, names or texts beyond sanitized upstream error messages). */
function loadMeta(snapshot: FinanceSnapshot) {
  return {
    window: snapshot.window,
    timeZone: snapshot.timeZone,
    fetchedAt: snapshot.generatedAt,
    completeness: snapshot.completeness,
    errors: snapshot.errors.slice(0, 20),
    errorsOmitted: Math.max(0, snapshot.errors.length - 20),
  };
}

function compactValue<T>(field: FieldValue<T>) {
  return field.reason === undefined
    ? { value: field.value, quality: field.quality }
    : { value: field.value, quality: field.quality, reason: field.reason };
}

/** Compact, explainable view of one record (no attachment texts). */
export function snapshotRow(r: FinanceRecord) {
  return {
    id: r.id,
    voucherType: r.voucherType,
    kind: r.kind,
    role: r.role,
    status: compactValue(r.status),
    statusCategory: r.statusCategory,
    voucherNumber: compactValue(r.voucherNumber),
    voucherDate: compactValue(r.voucherDate),
    dueDate: compactValue(r.dueDate),
    dueDateConfidence: r.dueDateConfidence,
    currency: compactValue(r.currency),
    grossCents: compactValue(r.grossCents),
    openCents: compactValue(r.openCents),
    counterparty: { name: compactValue(r.counterparty.name), basis: r.counterparty.matchKeyBasis },
    detail: r.provenance.detail,
    payment: r.payment.availability,
    issues: r.issues.map((i) => `${i.severity}:${i.code}${i.field ? `@${i.field}` : ""}`),
  };
}

function isOpenSalesDocument(r: FinanceRecord): boolean {
  return (r.voucherType === "invoice" || r.voucherType === "downpaymentinvoice") && (r.statusCategory === "OPEN" || r.statusCategory === "OVERDUE");
}

function isOpenDocument(r: FinanceRecord): boolean {
  return r.statusCategory === "OPEN" || r.statusCategory === "OVERDUE";
}

export function registerFinanceIntelligenceTools(server: McpServer, client: LexwareClient, deps: FinanceToolDeps = {}): void {
  const readOnly = createReadOnlyLexwareClient(client);
  const clock = deps.now ?? (() => new Date());
  const load = (options: LoadOptions, now: Date) => loadFinanceSnapshot(readOnly, { ...options, now: () => now, timeZone: DEFAULT_TIME_ZONE });

  server.registerTool(
    {
      name: "get-finance-snapshot",
      description:
        "READ-ONLY finance truth layer: load Lexware documents for a voucher-date window (default: previous month " +
        "start to today) and return them normalized with per-value quality (STRUCTURED/DERIVED/PLACEHOLDER/CONFLICT/" +
        "MISSING), data-quality findings, and an honest completeness report (PARTIAL/FAILED instead of guessing). " +
        "Use it to trace any finance statement back to the underlying documents. Reads the voucher list only " +
        "unless includeDetails/includePayments are set. Amounts are integer cents (gross). " +
        REVENUE_SCOPE_NOTE,
      annotations: RO,
      inputSchema: {
        from: dayParam.optional().describe("First voucher day (YYYY-MM-DD). Default: first day of the previous month."),
        to: dayParam.optional().describe("Last voucher day (YYYY-MM-DD). Default: today (Europe/Berlin)."),
        basis: z.enum(["voucherDate", "createdDate"]).optional().describe("Window basis (default voucherDate)."),
        includeDetails: jsonBool(z.boolean()).optional().describe("Also read document details (1 request per document)."),
        includePayments: jsonBool(z.boolean()).optional().describe("Also read payment information (1 request per document)."),
        maxRows: jsonNum(z.number().int().min(1).max(500)).optional().describe("Rows returned (default 100, max 500)."),
        maxRequests: maxRequestsParam,
      },
    },
    async ({ from, to, basis, includeDetails, includePayments, maxRows, maxRequests }) => {
      const now = clock();
      const today = dayInTimeZone(now, DEFAULT_TIME_ZONE);
      const window = { from: from ?? previousMonthStart(today), to: to ?? today, basis: basis ?? ("voucherDate" as const) };
      try {
        requireWindow(window.from, window.to);
      } catch (err) {
        if (err instanceof InputError) return errorResult(err.message);
        throw err;
      }
      const snapshot = await load(
        { window, includeDetails: includeDetails ?? false, includePayments: includePayments ?? false, maxRequests: maxRequests ?? DEFAULT_TOOL_MAX_REQUESTS },
        now,
      );
      const limit = maxRows ?? 100;
      const dataQuality = assessDataQuality({
        records: snapshot.records,
        listComplete: snapshot.completeness.list === "COMPLETE",
        fetchFailures: fetchFailures(snapshot.completeness),
        rejectedRows: snapshot.rejectedRows.length,
      });
      const result = {
        ...loadMeta(snapshot),
        dataQuality,
        qualitySummary: snapshot.quality,
        rejectedRows: snapshot.rejectedRows.length,
        rows: snapshot.records.slice(0, limit).map(snapshotRow),
        rowsOmitted: Math.max(0, snapshot.records.length - limit),
        revenueScopeNote: REVENUE_SCOPE_NOTE,
      };
      const summary =
        `Finance snapshot ${window.from}..${window.to}: ${snapshot.records.length} documents, list ${snapshot.completeness.list}` +
        ` (${snapshot.completeness.listReason}), data quality ${dataQuality.grade}.`;
      return objectResult(result as unknown as Record<string, unknown>, summary);
    },
  );

  server.registerTool(
    {
      name: "analyze-voucher-duplicates",
      description:
        "READ-ONLY duplicate analysis over Lexware documents of the last N days (default 90). Deterministic rules " +
        "(E1 shared file hash, E2/P1 same counterparty + voucher number + amount, S1-S3 weaker combinations within a " +
        "day window) classify pairs as EXACT_DUPLICATE, PROBABLE_DUPLICATE or POSSIBLE_DUPLICATE with reason codes " +
        "and evidence; an equal amount alone is never a duplicate. Optional verifyFileHashes downloads the files of " +
        "candidate documents to compare SHA-256. Never changes, marks or deletes a document.",
      annotations: RO,
      inputSchema: {
        lookbackDays: jsonNum(z.number().int().min(1).max(366)).optional().describe("Window from today minus N days through today (default 90)."),
        windowDays: jsonNum(z.number().int().min(0).max(60)).optional().describe("Day window of the weaker rules (default 14)."),
        verifyFileHashes: jsonBool(z.boolean())
          .optional()
          .describe(
            `Download the attachments of up to ${MAX_HASH_CANDIDATES} candidate documents to compare file hashes (default false; costs requests).`,
          ),
        maxFindings: jsonNum(z.number().int().min(1).max(500)).optional().describe(`Findings returned (default ${DEFAULT_MAX_FINDINGS}; counts stay complete).`),
        maxRequests: maxRequestsParam,
      },
    },
    async ({ lookbackDays, windowDays, verifyFileHashes, maxFindings, maxRequests }) => {
      const now = clock();
      const today = dayInTimeZone(now, DEFAULT_TIME_ZONE);
      const window = { from: addDays(today, -(lookbackDays ?? 90)), to: today, basis: "voucherDate" as const };
      const budget = maxRequests ?? DEFAULT_TOOL_MAX_REQUESTS;
      const config = { windowDays: windowDays ?? 14 };
      const listOnly = await load({ window, includeDetails: false, includePayments: false, maxRequests: budget }, now);
      let snapshot = listOnly;
      let analysis = analyzeDuplicates(listOnly.records, config);
      let hashVerification: Record<string, unknown> = { performed: false, reason: "NOT_REQUESTED" };
      if (verifyFileHashes) {
        // Most severe findings first; at most MAX_HASH_CANDIDATES documents are downloaded.
        const allCandidates = [...new Set(analysis.findings.flatMap((f) => [...f.recordIds]))];
        const candidates = new Set(allCandidates.slice(0, MAX_HASH_CANDIDATES));
        const remaining = budget - listOnly.completeness.budget.used;
        if (candidates.size === 0) hashVerification = { performed: false, reason: "NO_CANDIDATES" };
        else if (remaining < 2) hashVerification = { performed: false, reason: "BUDGET" };
        else {
          // Enrich the SAME list (seedFrom): no second list read, and no finding can be lost to a smaller budget.
          snapshot = await load(
            {
              window,
              seedFrom: listOnly,
              includeDetails: true,
              includePayments: false,
              inspectAttachments: true,
              enrichOnly: (r) => candidates.has(r.id),
              maxRequests: Math.min(remaining, MAX_HASH_REQUESTS),
              extractor: deps.extractor,
            },
            now,
          );
          // Details can only add evidence; a list-level suspicion is never dropped silently.
          analysis = mergeVerifiedAnalysis(analysis, analyzeDuplicates(snapshot.records, config));
          hashVerification = {
            performed: true,
            candidates: candidates.size,
            candidatesNotVerified: allCandidates.length - candidates.size,
            attachments: snapshot.completeness.attachments,
            note: `File hashes are compared for duplicate candidates only (at most ${MAX_HASH_CANDIDATES} documents per call).`,
          };
        }
      }
      const findingLimit = maxFindings ?? DEFAULT_MAX_FINDINGS;
      const listed = analysis.findings.slice(0, findingLimit);
      const ids = new Set(listed.flatMap((f) => [...f.recordIds]));
      const dataQuality = assessDataQuality({
        records: snapshot.records,
        listComplete: snapshot.completeness.list === "COMPLETE",
        fetchFailures: fetchFailures(snapshot.completeness),
        rejectedRows: snapshot.rejectedRows.length,
      });
      const meta = loadMeta(snapshot);
      // One budget per call: report the caller's limit and every request of both phases.
      const totalBudget = {
        maxRequests: budget,
        used: listOnly.completeness.budget.used + (snapshot === listOnly ? 0 : snapshot.completeness.budget.used),
        exhausted: listOnly.completeness.budget.exhausted || snapshot.completeness.budget.exhausted,
      };
      const result = {
        ...meta,
        completeness: { ...meta.completeness, budget: totalBudget },
        analysis: { ...analysis, findings: listed },
        findingsOmitted: analysis.findings.length - listed.length,
        documents: snapshot.records.filter((r) => ids.has(r.id)).map(snapshotRow),
        hashVerification,
        dataQuality,
      };
      const c = analysis.counts;
      const summary =
        `Duplicate analysis ${window.from}..${window.to}: exact ${c.EXACT_DUPLICATE}, probable ${c.PROBABLE_DUPLICATE}, ` +
        `possible ${c.POSSIBLE_DUPLICATE} (${analysis.recordsConsidered} documents, list ${snapshot.completeness.list}` +
        `${analysis.complete ? "" : ", INCOMPLETE: pair limit"}).`;
      return objectResult(result as unknown as Record<string, unknown>, summary);
    },
  );

  server.registerTool(
    {
      name: "get-open-items",
      description:
        "READ-ONLY open items (receivables / payables) of the last N days (default 180) with conservative status: " +
        "OVERDUE_CONFIRMED only with a reliable due date (stated payment term or own due date); a due date equal to " +
        "the voucher date without payment term gives at most POSSIBLY_OVERDUE. Also OPEN_CONFIRMED, " +
        "DUE_DATE_UNRELIABLE, STATUS_UNKNOWN (e.g. unreviewed inbox documents, contradictions) and PAID_CONFIRMED. " +
        "Totals use only usable open amounts. Credit notes have an unverified direction and are not totalled.",
      annotations: RO,
      inputSchema: {
        lookbackDays: jsonNum(z.number().int().min(1).max(730)).optional().describe("Window from today minus N days through today (default 180)."),
        direction: z.enum(["all", "receivable", "payable"]).optional().describe("Filter the returned items (totals stay complete)."),
        includePaid: jsonBool(z.boolean()).optional().describe("Also list PAID_CONFIRMED items (default false; always counted)."),
        verifyDueDates: jsonBool(z.boolean())
          .optional()
          .describe("Read details of open sales documents to check their payment term (default true)."),
        includePaymentInfo: jsonBool(z.boolean())
          .optional()
          .describe("Read Lexware payment information for open documents (default false; 1 request each)."),
        maxItems: jsonNum(z.number().int().min(1).max(500)).optional().describe("Items returned (default 100)."),
        maxRequests: maxRequestsParam,
      },
    },
    async ({ lookbackDays, direction, includePaid, verifyDueDates, includePaymentInfo, maxItems, maxRequests }) => {
      const now = clock();
      const today = dayInTimeZone(now, DEFAULT_TIME_ZONE);
      const window = { from: addDays(today, -(lookbackDays ?? 180)), to: today, basis: "voucherDate" as const };
      const verify = verifyDueDates ?? true;
      const payments = includePaymentInfo ?? false;
      const snapshot = await load(
        {
          window,
          includeDetails: verify,
          includePayments: payments,
          enrichOnly: payments ? isOpenDocument : isOpenSalesDocument,
          // Due-date details are only useful for sales documents (payment term); payments may cover all open documents.
          detailsOnly: isOpenSalesDocument,
          maxRequests: maxRequests ?? DEFAULT_TOOL_MAX_REQUESTS,
        },
        now,
      );
      const analysis = analyzeOpenItems(snapshot.records, today);
      const wanted = direction === "receivable" ? "RECEIVABLE" : direction === "payable" ? "PAYABLE" : null;
      const filtered = analysis.items.filter((i) => (wanted === null || i.direction === wanted) && (includePaid || i.status !== "PAID_CONFIRMED"));
      const limit = maxItems ?? 100;
      const dataQuality = assessDataQuality({
        records: snapshot.records,
        listComplete: snapshot.completeness.list === "COMPLETE",
        fetchFailures: fetchFailures(snapshot.completeness),
        rejectedRows: snapshot.rejectedRows.length,
        openItems: analysis,
      });
      const result = {
        ...loadMeta(snapshot),
        asOf: today,
        coverage: `Only documents with a voucher date from ${window.from} to ${window.to} were checked.`,
        counts: analysis.counts,
        totals: analysis.totals,
        excluded: analysis.excluded,
        items: filtered.slice(0, limit),
        itemsOmitted: Math.max(0, filtered.length - limit),
        dataQuality,
      };
      const n = analysis.counts;
      const summary =
        `Open items as of ${today} (${window.from}..${window.to}, list ${snapshot.completeness.list}): ` +
        `overdue confirmed ${n.OVERDUE_CONFIRMED}, possibly overdue ${n.POSSIBLY_OVERDUE}, due date unreliable ${n.DUE_DATE_UNRELIABLE}, ` +
        `open confirmed ${n.OPEN_CONFIRMED}, status unknown ${n.STATUS_UNKNOWN}, paid confirmed ${n.PAID_CONFIRMED}.`;
      return objectResult(result as unknown as Record<string, unknown>, summary);
    },
  );

  server.registerTool(
    {
      name: "compare-finance-periods",
      description:
        "READ-ONLY month comparison: current month to date vs. the same days of the previous month and vs. the full " +
        "previous month — purchase documents, reliable expenses (gross, reviewed documents only), Lexware invoice " +
        "revenue (NOT point-of-sale revenue), currently open amounts, unreviewed documents, top suppliers — with " +
        "absolute and relative differences and the anomaly rule (default: >= 30 % AND >= 250.00 EUR, like-for-like " +
        "days only, not evaluated on incomplete data).",
      annotations: RO,
      inputSchema: {
        asOf: dayParam.optional().describe("Reference day (YYYY-MM-DD, not in the future). Default: today (Europe/Berlin)."),
        includeDetails: jsonBool(z.boolean()).optional().describe("Read document details for cost-category totals (1 request per document)."),
        minRelativeChangePercent: jsonNum(z.number().min(0).max(1000)).optional().describe("Anomaly rule: minimum |relative change| in % (default 30)."),
        minAbsoluteChangeCents: jsonNum(z.number().int().min(0).max(10_000_000_000)).optional().describe("Anomaly rule: minimum |absolute change| in cents (default 25000)."),
        maxRequests: maxRequestsParam,
      },
    },
    async ({ asOf, includeDetails, minRelativeChangePercent, minAbsoluteChangeCents, maxRequests }) => {
      const now = clock();
      const today = dayInTimeZone(now, DEFAULT_TIME_ZONE);
      const day = asOf ?? today;
      if (!isValidDay(day)) return errorResult("asOf must be a valid YYYY-MM-DD day");
      if (day > today) return errorResult("asOf must not be in the future");
      if (day < MIN_DAY) return errorResult(`asOf must not be before ${MIN_DAY}`);
      const config = {
        ...(minRelativeChangePercent === undefined ? {} : { minRelativeChangePercent }),
        ...(minAbsoluteChangeCents === undefined ? {} : { minAbsoluteChangeCents }),
      };
      try {
        resolveAnomalyConfig(config); // invalid input never costs a Lexware request
      } catch (err) {
        if (err instanceof RangeError) return errorResult(err.message);
        throw err;
      }
      const window = { from: previousMonthStart(day), to: day, basis: "voucherDate" as const };
      const snapshot = await load(
        { window, includeDetails: includeDetails ?? false, includePayments: false, maxRequests: maxRequests ?? DEFAULT_TOOL_MAX_REQUESTS },
        now,
      );
      const comparison = comparePeriods(snapshot.records, day, { dataComplete: snapshot.completeness.list === "COMPLETE", config });
      const dataQuality = assessDataQuality({
        records: snapshot.records,
        listComplete: snapshot.completeness.list === "COMPLETE",
        fetchFailures: fetchFailures(snapshot.completeness),
        rejectedRows: snapshot.rejectedRows.length,
      });
      const result = {
        ...loadMeta(snapshot),
        statusNote: "Statuses and open amounts are as of the fetch time, not as of asOf.",
        comparison: { ...comparison, anomalies: comparison.anomalies.slice(0, MAX_ANOMALIES_LISTED) },
        anomaliesOmitted: Math.max(0, comparison.anomalies.length - MAX_ANOMALIES_LISTED),
        dataQuality,
      };
      const summary =
        `Period comparison as of ${day} (list ${snapshot.completeness.list}): ${comparison.anomalies.length} anomalies, ` +
        `${comparison.notEvaluated.length} checks not evaluated, data quality ${dataQuality.grade}. ${REVENUE_SCOPE_NOTE}`;
      return objectResult(result as unknown as Record<string, unknown>, summary);
    },
  );

  server.registerTool(
    {
      name: "get-finance-daily-brief",
      description:
        "READ-ONLY LU'S Finance Daily: one deterministic brief (status GRÜN/GELB/ROT with reasons, data quality, month " +
        "to date, comparison with the previous month, duplicates, anomalies, owner attention, no action needed), " +
        "rendered from code — no free text for numbers or statuses. Built from a single budgeted Lexware load. " +
        REVENUE_SCOPE_NOTE,
      annotations: RO,
      inputSchema: {
        openItemsLookbackDays: jsonNum(z.number().int().min(31).max(730))
          .optional()
          .describe("Days back for open items and duplicates (default 180; the previous month is always included)."),
        verifyDueDates: jsonBool(z.boolean()).optional().describe("Read details of open sales documents for their payment term (default true)."),
        maxRequests: maxRequestsParam,
      },
    },
    async ({ openItemsLookbackDays, verifyDueDates, maxRequests }) => {
      const now = clock();
      const today = dayInTimeZone(now, DEFAULT_TIME_ZONE);
      const lookbackFrom = addDays(today, -(openItemsLookbackDays ?? 180));
      const monthFrom = previousMonthStart(today);
      const window = { from: lookbackFrom < monthFrom ? lookbackFrom : monthFrom, to: today, basis: "voucherDate" as const };
      const verify = verifyDueDates ?? true;
      const snapshot = await load(
        {
          window,
          includeDetails: verify,
          includePayments: false,
          enrichOnly: isOpenSalesDocument,
          maxRequests: maxRequests ?? DEFAULT_TOOL_MAX_REQUESTS,
        },
        now,
      );
      const listComplete = snapshot.completeness.list === "COMPLETE";
      const openItems = analyzeOpenItems(snapshot.records, today);
      const duplicates = analyzeDuplicates(snapshot.records);
      const periods = comparePeriods(snapshot.records, today, { dataComplete: listComplete });
      const dataQuality = assessDataQuality({
        records: snapshot.records,
        listComplete,
        fetchFailures: fetchFailures(snapshot.completeness),
        rejectedRows: snapshot.rejectedRows.length,
        openItems,
      });
      const brief = buildDailyBrief({
        asOf: today,
        timeZone: snapshot.timeZone,
        fetchedAt: snapshot.generatedAt,
        load: {
          list: snapshot.completeness.list,
          listReason: snapshot.completeness.listReason,
          window: { from: window.from, to: window.to },
          budgetExhausted: snapshot.completeness.budget.exhausted,
          errors: snapshot.errors.length,
        },
        dataQuality,
        periods,
        openItems,
        duplicates,
        records: snapshot.records,
      });
      const result = {
        status: brief.status,
        statusReasons: brief.statusReasons,
        ownerAttention: brief.ownerAttention,
        noActionNeeded: brief.noActionNeeded,
        asOf: today,
        dataQuality: { grade: dataQuality.grade, triggeredBy: dataQuality.triggeredBy, scope: dataQuality.scope },
        duplicates: duplicates.counts,
        openItems: openItems.counts,
        anomalies: periods.anomalies.length,
        rejectedRows: snapshot.rejectedRows.length,
        ...loadMeta(snapshot),
        revenueScopeNote: REVENUE_SCOPE_NOTE,
      };
      return { structuredContent: result as unknown as Record<string, unknown>, content: text(brief.text) };
    },
  );
}
