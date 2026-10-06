/**
 * Read-only loader: fetches Lexware data for a date window and normalizes it into a {@link FinanceSnapshot}.
 *
 * - Uses only the GET-only {@link ReadOnlyLexwareClient} facade; it cannot write to Lexware.
 * - Works within an explicit request budget (Lexware allows ~2 requests/second) and reports exactly what
 *   was not fetched instead of pretending completeness.
 * - Never throws for upstream failures: they are recorded in `errors` and reflected in `completeness`.
 */
import { LexwareApiError, ResponseTooLargeError, UnsafeRequestPathError } from "../lexware/errors.js";
import { type PdfTextExtractor, inspectLexwareFile } from "../lexware/file-inspection.js";
import type { ReadOnlyLexwareClient } from "../lexware/read-only-client.js";
import { cleanUntrustedText } from "../untrusted.js";
import { dayInTimeZone } from "./dates.js";
import { DEFAULT_TIME_ZONE, FINANCE_SCHEMA_VERSION, type FinanceRecord, type RejectedRow } from "./model.js";
import {
  type CategoryIndex,
  type NormalizeContext,
  applyAttachmentInspection,
  applyCategories,
  applyPayment,
  applySalesDocumentDetail,
  applyVoucherDetail,
  buildCategoryIndex,
  detailSourceFor,
  markAttachmentState,
  markDetailFailed,
  markPaymentFailed,
  markPaymentNotAvailable,
  markPaymentSkipped,
  normalizeVoucherlistRow,
} from "./normalize.js";
import { type QualitySummary, summarizeQuality } from "./quality.js";
import { isUsable } from "./values.js";

export interface LoadWindow {
  /** Inclusive first calendar day, YYYY-MM-DD. */
  readonly from: string;
  /** Inclusive last calendar day, YYYY-MM-DD. */
  readonly to: string;
  readonly basis: "voucherDate" | "createdDate";
}

export interface LoadOptions {
  readonly window: LoadWindow;
  readonly includeDetails?: boolean;
  readonly includePayments?: boolean;
  readonly inspectAttachments?: boolean;
  /** Maximum Lexware requests for this load (retries inside the client are not counted). */
  readonly maxRequests?: number;
  readonly maxListPages?: number;
  readonly maxCharactersPerFile?: number;
  readonly timeZone?: string;
  readonly now?: () => Date;
  readonly extractor?: PdfTextExtractor;
}

export const DEFAULT_MAX_REQUESTS = 150;
export const MAX_REQUESTS_LIMIT = 2000;
const LIST_PAGE_SIZE = 250;
const DEFAULT_MAX_LIST_PAGES = 20;
const DEFAULT_MAX_CHARS_PER_FILE = 20_000;
const MAX_ERROR_MESSAGE_CHARS = 200;

export type Stage = "list" | "categories" | "detail" | "payment" | "attachment";

export interface LoadError {
  readonly stage: Stage;
  readonly recordId?: string;
  /** HTTP status, 0 for transport errors, null for local errors. */
  readonly status: number | null;
  readonly kind: string;
  readonly message: string;
}

export interface StageCounts {
  readonly needed: number;
  readonly fetched: number;
  readonly failed: number;
  /** Not attempted because the request budget ran out. */
  readonly skippedBudget: number;
}

export interface Completeness {
  readonly list: "COMPLETE" | "PARTIAL" | "FAILED";
  readonly listReason: "OK" | "PAGE_LIMIT" | "BUDGET" | "ERROR" | "INVALID_RESPONSE";
  readonly categories: "LOADED" | "FAILED" | "NOT_NEEDED" | "SKIPPED_BUDGET";
  readonly details: StageCounts;
  readonly payments: StageCounts & { readonly notApplicable: number };
  readonly attachments: StageCounts;
  readonly budget: { readonly maxRequests: number; readonly used: number; readonly exhausted: boolean };
  readonly duplicateRowsDropped: number;
  readonly outsideWindowDropped: number;
}

export interface FinanceSnapshot {
  readonly schemaVersion: typeof FINANCE_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly timeZone: string;
  readonly window: LoadWindow;
  readonly records: ReadonlyArray<FinanceRecord>;
  readonly rejectedRows: ReadonlyArray<RejectedRow>;
  readonly completeness: Completeness;
  readonly errors: ReadonlyArray<LoadError>;
  readonly quality: QualitySummary;
}

class BudgetExhausted extends Error {}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Validate a load window; throws RangeError on invalid input (a caller error, not a data condition). */
export function assertValidWindow(window: LoadWindow): void {
  if (!validDay(window.from) || !validDay(window.to)) throw new RangeError("window.from/to must be valid YYYY-MM-DD days");
  if (window.from > window.to) throw new RangeError("window.from must not be after window.to");
  if (window.basis !== "voucherDate" && window.basis !== "createdDate") throw new RangeError("window.basis is invalid");
}

function describeError(stage: Stage, err: unknown, recordId?: string): LoadError {
  const message = cleanUntrustedText(err instanceof Error ? err.message : String(err), {
    maxChars: MAX_ERROR_MESSAGE_CHARS,
    singleLine: true,
  }).text;
  if (err instanceof LexwareApiError) return { stage, recordId, status: err.status, kind: err.kind, message };
  if (err instanceof UnsafeRequestPathError) return { stage, recordId, status: null, kind: "unsafe_path", message };
  if (err instanceof ResponseTooLargeError) return { stage, recordId, status: null, kind: "too_large", message };
  return { stage, recordId, status: null, kind: "local", message };
}

function basisDay(record: FinanceRecord, basis: LoadWindow["basis"], timeZone: string): string | null {
  if (basis === "voucherDate") return isUsable(record.voucherDate) ? record.voucherDate.value : null;
  return isUsable(record.createdAt) ? dayInTimeZone(new Date(record.createdAt.value), timeZone) : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const PAYMENT_SKIP = new Set(["UNCHECKED", "DRAFT", "VOIDED"]);

export async function loadFinanceSnapshot(client: ReadOnlyLexwareClient, options: LoadOptions): Promise<FinanceSnapshot> {
  assertValidWindow(options.window);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const now = options.now ?? (() => new Date());
  const maxRequests = Math.min(Math.max(1, Math.floor(options.maxRequests ?? DEFAULT_MAX_REQUESTS)), MAX_REQUESTS_LIMIT);
  const maxListPages = Math.max(1, Math.floor(options.maxListPages ?? DEFAULT_MAX_LIST_PAGES));
  const includeDetails = options.includeDetails ?? true;
  const includePayments = options.includePayments ?? true;
  const inspectAttachments = options.inspectAttachments ?? false;
  const generatedAt = now().toISOString();

  let used = 0;
  let exhausted = false;
  const budgeted = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (used >= maxRequests) {
      exhausted = true;
      throw new BudgetExhausted();
    }
    used += 1;
    return fn();
  };
  const ctx = (): NormalizeContext => ({ fetchedAt: now().toISOString(), timeZone });
  const errors: LoadError[] = [];

  // 1. Voucherlist (all types and statuses; filtered and classified locally).
  const { window } = options;
  const byId = new Map<string, FinanceRecord>();
  const rejectedRows: RejectedRow[] = [];
  let duplicateRowsDropped = 0;
  let list: Completeness["list"] = "COMPLETE";
  let listReason: Completeness["listReason"] = "OK";
  let rowIndex = 0;

  for (let page = 0; ; page++) {
    if (page >= maxListPages) {
      list = "PARTIAL";
      listReason = "PAGE_LIMIT";
      break;
    }
    let res: unknown;
    try {
      res = await budgeted(() =>
        client.get<unknown>("/v1/voucherlist", {
          voucherType: "any",
          voucherStatus: "any",
          [`${window.basis}From`]: window.from,
          [`${window.basis}To`]: window.to,
          page,
          size: LIST_PAGE_SIZE,
        }),
      );
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        list = page === 0 ? "FAILED" : "PARTIAL";
        listReason = "BUDGET";
      } else {
        list = page === 0 ? "FAILED" : "PARTIAL";
        listReason = "ERROR";
        errors.push(describeError("list", err));
      }
      break;
    }
    if (!isObject(res) || !Array.isArray(res.content)) {
      list = page === 0 ? "FAILED" : "PARTIAL";
      listReason = "INVALID_RESPONSE";
      errors.push({ stage: "list", status: null, kind: "invalid_response", message: "voucherlist response has no content array" });
      break;
    }
    const c = ctx();
    for (const row of res.content) {
      const out = normalizeVoucherlistRow(row, rowIndex++, c);
      if ("rejected" in out) {
        rejectedRows.push(out.rejected);
      } else if (byId.has(out.record.id)) {
        duplicateRowsDropped += 1;
      } else {
        byId.set(out.record.id, out.record);
      }
    }
    const totalPages = typeof res.totalPages === "number" ? res.totalPages : null;
    if (res.content.length === 0 || res.last === true || (totalPages !== null && page + 1 >= totalPages)) break;
  }

  // Local window check (Lexware's filter semantics are not relied on for inclusiveness).
  let outsideWindowDropped = 0;
  const records = new Map<string, FinanceRecord>();
  for (const r of byId.values()) {
    const day = basisDay(r, window.basis, timeZone);
    if (day !== null && (day < window.from || day > window.to)) {
      outsideWindowDropped += 1;
      continue;
    }
    records.set(r.id, r);
  }

  // Newest first, deterministic.
  const order = [...records.values()]
    .sort((a, b) => {
      const da = basisDay(a, window.basis, timeZone) ?? "";
      const db = basisDay(b, window.basis, timeZone) ?? "";
      return da === db ? a.id.localeCompare(b.id) : db.localeCompare(da);
    })
    .map((r) => r.id);
  const financial = order.filter((id) => {
    const k = records.get(id)!.kind;
    return k === "EXPENSE" || k === "REVENUE";
  });
  const set = (r: FinanceRecord) => records.set(r.id, r);
  const get = (id: string) => records.get(id)!;

  // 2. Posting categories (one request) when bookkeeping details will be read.
  let categories: Completeness["categories"] = "NOT_NEEDED";
  let categoryIndex: CategoryIndex | null = null;
  const needsCategories = includeDetails && financial.some((id) => detailSourceFor(get(id).voucherType)?.source === "voucher");
  if (needsCategories) {
    try {
      categoryIndex = buildCategoryIndex(await budgeted(() => client.get<unknown>("/v1/posting-categories")));
      categories = "LOADED";
    } catch (err) {
      if (err instanceof BudgetExhausted) categories = "SKIPPED_BUDGET";
      else {
        categories = "FAILED";
        errors.push(describeError("categories", err));
      }
    }
  }

  // 3. Details.
  const details = { needed: 0, fetched: 0, failed: 0, skippedBudget: 0 };
  if (includeDetails) {
    for (const id of financial) {
      const target = detailSourceFor(get(id).voucherType);
      if (!target) continue;
      details.needed += 1;
      try {
        const raw = await budgeted(() => client.get<unknown>(`${target.path}/${encodeURIComponent(id)}`));
        let next =
          target.source === "voucher"
            ? applyVoucherDetail(get(id), raw, ctx())
            : applySalesDocumentDetail(get(id), raw, target.source, ctx());
        if (next.provenance.detail === "FETCHED") {
          details.fetched += 1;
          next = applyCategories(next, categoryIndex);
        } else {
          details.failed += 1;
        }
        set(next);
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          details.skippedBudget += 1;
          continue;
        }
        details.failed += 1;
        errors.push(describeError("detail", err, id));
        set(markDetailFailed(get(id)));
      }
    }
  }

  // 4. Payments.
  const payments = { needed: 0, fetched: 0, failed: 0, skippedBudget: 0, notApplicable: 0 };
  if (includePayments) {
    for (const id of financial) {
      const r = get(id);
      if (PAYMENT_SKIP.has(r.statusCategory)) {
        payments.notApplicable += 1;
        set(markPaymentSkipped(r));
        continue;
      }
      payments.needed += 1;
      try {
        const raw = await budgeted(() => client.get<unknown>(`/v1/payments/${encodeURIComponent(id)}`));
        const next = applyPayment(r, raw, ctx());
        if (next.payment.availability === "AVAILABLE") payments.fetched += 1;
        else payments.failed += 1;
        set(next);
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          payments.skippedBudget += 1;
          continue;
        }
        if (err instanceof LexwareApiError && err.status === 406) {
          payments.fetched += 1; // Lexware answered: no payment information for this voucher.
          set(markPaymentNotAvailable(r));
          continue;
        }
        payments.failed += 1;
        errors.push(describeError("payment", err, id));
        set(markPaymentFailed(r));
      }
    }
  }

  // 5. Attachments (download + SHA-256 + text; optional, expensive).
  const attachments = { needed: 0, fetched: 0, failed: 0, skippedBudget: 0 };
  if (inspectAttachments) {
    const budgetedClient = {
      getBinary: (path: string, accept?: string, opts?: { maxBytes?: number }) =>
        budgeted(() => client.getBinary(path, accept, opts)),
    };
    for (const id of financial) {
      const files = get(id).attachments.value;
      if (files === null || files.length === 0) continue;
      let skipped = false;
      let failed = false;
      for (const f of files) {
        attachments.needed += 1;
        try {
          const result = await inspectLexwareFile(
            budgetedClient,
            f.fileId,
            { maxCharacters: options.maxCharactersPerFile ?? DEFAULT_MAX_CHARS_PER_FILE },
            options.extractor,
          );
          attachments.fetched += 1;
          set(applyAttachmentInspection(get(id), result, ctx()));
        } catch (err) {
          if (err instanceof BudgetExhausted) {
            attachments.skippedBudget += 1;
            skipped = true;
            continue;
          }
          attachments.failed += 1;
          failed = true;
          errors.push(describeError("attachment", err, id));
        }
      }
      set(markAttachmentState(get(id), failed ? "FAILED" : skipped ? "SKIPPED" : "FETCHED"));
    }
  }

  const finalRecords = order.map((id) => get(id));
  return {
    schemaVersion: FINANCE_SCHEMA_VERSION,
    generatedAt,
    timeZone,
    window,
    records: finalRecords,
    rejectedRows,
    completeness: {
      list,
      listReason,
      categories,
      details,
      payments,
      attachments,
      budget: { maxRequests, used, exhausted },
      duplicateRowsDropped,
      outsideWindowDropped,
    },
    errors,
    quality: summarizeQuality(finalRecords),
  };
}
