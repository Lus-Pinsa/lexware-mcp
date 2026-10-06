/**
 * Normalization of raw Lexware read responses into {@link FinanceRecord}s.
 *
 * Pure functions: no I/O, no clock (the fetch time is passed in), no hidden defaults. Every input is
 * treated as untrusted JSON: unexpected shapes become MISSING/INVALID values with a reason, never guesses.
 * Merging a second source never overwrites a disagreeing value silently — it becomes a CONFLICT.
 */
import { cleanUntrustedText } from "../untrusted.js";
import { parseLexwareDate } from "./dates.js";
import {
  type Attachment,
  type AttachmentInspection,
  type Candidate,
  type CategoryType,
  type Counterparty,
  type DocumentRole,
  type DueDateConfidence,
  FINANCE_SCHEMA_VERSION,
  type FieldValue,
  type FinanceKind,
  type FinanceRecord,
  ISSUE_SEVERITY,
  type IssueCode,
  type LineItem,
  type PaymentInfo,
  type PaymentItem,
  type QualityIssue,
  type Reason,
  type RejectedRow,
  type Source,
  type StatusCategory,
} from "./model.js";
import { parseAmountToCents } from "./money.js";
import { conflict, derived, isUsable, missing, placeholder, structured } from "./values.js";

export interface NormalizeContext {
  /** ISO instant the response was fetched (provenance only). */
  readonly fetchedAt: string;
  /** Business time zone for calendar days. */
  readonly timeZone: string;
}

/** Caps for untrusted short texts. */
const MAX_NAME_CHARS = 200;
const MAX_NUMBER_CHARS = 100;
const MAX_CODE_CHARS = 60;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

type Raw = Record<string, unknown>;

function isObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------

const TYPE_TABLE: Readonly<Record<string, { kind: FinanceKind; role: DocumentRole }>> = {
  purchaseinvoice: { kind: "EXPENSE", role: "INVOICE" },
  purchasecreditnote: { kind: "EXPENSE", role: "CREDIT_NOTE" },
  salesinvoice: { kind: "REVENUE", role: "INVOICE" },
  invoice: { kind: "REVENUE", role: "INVOICE" },
  salescreditnote: { kind: "REVENUE", role: "CREDIT_NOTE" },
  creditnote: { kind: "REVENUE", role: "CREDIT_NOTE" },
  downpaymentinvoice: { kind: "REVENUE", role: "DOWN_PAYMENT_INVOICE" },
  quotation: { kind: "NON_FINANCIAL", role: "OTHER" },
  orderconfirmation: { kind: "NON_FINANCIAL", role: "OTHER" },
  deliverynote: { kind: "NON_FINANCIAL", role: "OTHER" },
  dunning: { kind: "NON_FINANCIAL", role: "OTHER" },
  recurringtemplate: { kind: "NON_FINANCIAL", role: "OTHER" },
};

export function classifyVoucherType(voucherType: string): { kind: FinanceKind; role: DocumentRole; known: boolean } {
  const hit = TYPE_TABLE[voucherType];
  return hit ? { ...hit, known: true } : { kind: "UNKNOWN", role: "OTHER", known: false };
}

/** Which detail endpoint describes a voucher type (null: none / not needed). */
export type DetailSource = Extract<Source, "voucher" | "invoice" | "credit-note" | "down-payment-invoice">;

export function detailSourceFor(voucherType: string): { path: string; source: DetailSource } | null {
  switch (voucherType) {
    case "purchaseinvoice":
    case "purchasecreditnote":
    case "salesinvoice":
    case "salescreditnote":
      return { path: "/v1/vouchers", source: "voucher" };
    case "invoice":
      return { path: "/v1/invoices", source: "invoice" };
    case "creditnote":
      return { path: "/v1/credit-notes", source: "credit-note" };
    case "downpaymentinvoice":
      return { path: "/v1/down-payment-invoices", source: "down-payment-invoice" };
    default:
      return null;
  }
}

const STATUS_TABLE: Readonly<Record<string, StatusCategory>> = {
  unchecked: "UNCHECKED",
  draft: "DRAFT",
  open: "OPEN",
  overdue: "OVERDUE",
  paid: "PAID",
  paidoff: "PAID",
  voided: "VOIDED",
  // Known Lexware statuses whose accounting meaning is not verified here: kept raw, categorized OTHER.
  transferred: "OTHER",
  sepadebit: "OTHER",
  accepted: "OTHER",
  rejected: "OTHER",
  paymentordered: "OTHER",
};

export function categorizeStatus(status: string | null): { category: StatusCategory; known: boolean } {
  if (status === null) return { category: "UNKNOWN", known: false };
  const hit = STATUS_TABLE[status];
  return hit ? { category: hit, known: true } : { category: "UNKNOWN", known: false };
}

/** The voucherlist computes "overdue"; detail endpoints report the stored status "open". */
function statusesCompatible(a: string, b: string): boolean {
  return a === b || (a === "overdue" && b === "open") || (a === "open" && b === "overdue");
}

// ---------------------------------------------------------------------------------------------------------
// Field readers (raw JSON value -> FieldValue)
// ---------------------------------------------------------------------------------------------------------

function readShortText(raw: unknown, source: Source, maxChars: number): FieldValue<string> {
  if (raw === undefined || raw === null) return missing("FIELD_ABSENT", source);
  if (typeof raw !== "string") return missing("INVALID_TYPE", source);
  const cleaned = cleanUntrustedText(raw, { maxChars, singleLine: true }).text;
  return cleaned === "" ? missing("EMPTY_STRING", source) : structured(cleaned, source);
}

function readCode(raw: unknown, source: Source): FieldValue<string> {
  const text = readShortText(raw, source, MAX_CODE_CHARS);
  return isUsable(text) ? structured(text.value.toLowerCase(), source) : text;
}

function readId(raw: unknown, source: Source): FieldValue<string> {
  if (raw === undefined || raw === null) return missing("FIELD_ABSENT", source);
  if (typeof raw !== "string") return missing("INVALID_TYPE", source);
  if (raw.trim() === "") return missing("EMPTY_STRING", source);
  return ID_PATTERN.test(raw) ? structured(raw, source) : missing("INVALID_FORMAT", source);
}

function readCurrency(raw: unknown, source: Source): FieldValue<string> {
  if (raw === undefined || raw === null) return missing("FIELD_ABSENT", source);
  if (typeof raw !== "string") return missing("INVALID_TYPE", source);
  return CURRENCY_PATTERN.test(raw) ? structured(raw, source) : missing("INVALID_FORMAT", source);
}

function readDay(raw: unknown, source: Source, timeZone: string): FieldValue<string> {
  const parsed = parseLexwareDate(raw, timeZone);
  return parsed.ok ? structured(parsed.day, source) : missing(parsed.reason, source);
}

function readInstant(raw: unknown, source: Source, timeZone: string): FieldValue<string> {
  const parsed = parseLexwareDate(raw, timeZone);
  if (!parsed.ok) return missing(parsed.reason, source);
  return parsed.instant === null ? missing("INVALID_FORMAT", source) : structured(parsed.instant, source);
}

interface AmountRead {
  readonly field: FieldValue<number>;
  readonly precisionReduced: boolean;
}

function readAmount(raw: unknown, source: Source): AmountRead {
  const parsed = parseAmountToCents(raw);
  if (!parsed.ok) return { field: missing(parsed.reason, source), precisionReduced: false };
  return { field: structured(parsed.cents, source), precisionReduced: parsed.precisionReduced };
}

function readBoolean(raw: unknown, source: Source): FieldValue<boolean> {
  if (raw === undefined || raw === null) return missing("FIELD_ABSENT", source);
  return typeof raw === "boolean" ? structured(raw, source) : missing("INVALID_TYPE", source);
}

function readPercent(raw: unknown, source: Source): FieldValue<number> {
  if (raw === undefined || raw === null) return missing("FIELD_ABSENT", source);
  if (typeof raw !== "number" || !Number.isFinite(raw)) return missing("INVALID_TYPE", source);
  return raw < 0 || raw > 100 ? missing("INVALID_FORMAT", source) : structured(raw, source);
}

// ---------------------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------------------

function valuesEqual<T>(a: T, b: T): boolean {
  return a === b;
}

/**
 * Combine an existing value with a value from another source.
 * - only one usable → that one
 * - both usable and equal → keep the existing (first) source
 * - both usable and different → CONFLICT with both candidates
 * - neither usable → keep the existing (it carries the original reason), unless the new one is a PLACEHOLDER
 */
function mergeField<T>(current: FieldValue<T>, incoming: FieldValue<T>, equal = valuesEqual<T>): FieldValue<T> {
  if (current.quality === "CONFLICT") {
    if (!isUsable(incoming)) return current;
    const candidates = current.candidates ?? [];
    if (candidates.some((c) => equal(c.value, incoming.value as T))) return current;
    return conflict([...candidates, { source: incoming.source ?? "derived", value: incoming.value as T }]);
  }
  const cu = isUsable(current);
  const iu = isUsable(incoming);
  if (cu && iu) {
    if (equal(current.value as T, incoming.value as T)) return current;
    const candidates: Candidate<T>[] = [
      { source: current.source ?? "derived", value: current.value as T },
      { source: incoming.source ?? "derived", value: incoming.value as T },
    ];
    return conflict(candidates);
  }
  if (iu) return incoming;
  if (cu) return current;
  return incoming.quality === "PLACEHOLDER" ? incoming : current;
}

function withSource(record: FinanceRecord, source: Source, fetchedAt: string): FinanceRecord["provenance"]["sources"] {
  return [...record.provenance.sources, { source, fetchedAt }];
}

// ---------------------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------------------

/** Issues that record an event during merging and cannot be recomputed from field states alone. */
const EVENT_ISSUES: ReadonlySet<IssueCode> = new Set<IssueCode>([
  "AMOUNT_PRECISION_REDUCED",
  "LINE_ITEM_SUM_MISMATCH",
  "TOTALS_INCONSISTENT",
  "DETAIL_ID_MISMATCH",
]);

function issue(code: IssueCode, field?: string): QualityIssue {
  return field === undefined ? { code, severity: ISSUE_SEVERITY[code] } : { code, severity: ISSUE_SEVERITY[code], field };
}

function addEventIssue(record: FinanceRecord, code: IssueCode, field?: string): FinanceRecord {
  const exists = record.issues.some((i) => i.code === code && i.field === field);
  return exists ? record : { ...record, issues: [...record.issues, issue(code, field)] };
}

function dueDateConfidence(record: FinanceRecord, paymentTermStated: boolean): DueDateConfidence {
  if (!isUsable(record.dueDate)) return "MISSING";
  if (paymentTermStated) return "PAYMENT_TERM";
  if (isUsable(record.voucherDate) && record.voucherDate.value === record.dueDate.value) return "POSSIBLE_DEFAULT";
  return "LEXWARE_FIELD";
}

function isFinancial(record: FinanceRecord): boolean {
  return record.kind === "EXPENSE" || record.kind === "REVENUE";
}

/** Recompute all field-derived issues; event issues are kept. Deterministic order (by code, then field). */
export function recomputeIssues(record: FinanceRecord): FinanceRecord {
  const out: QualityIssue[] = record.issues.filter((i) => EVENT_ISSUES.has(i.code));
  const add = (code: IssueCode, field?: string) => out.push(issue(code, field));
  const financial = isFinancial(record);

  if (record.kind === "UNKNOWN") add("UNKNOWN_VOUCHER_TYPE", "voucherType");
  if (record.status.quality === "CONFLICT") add("STATUS_SOURCES_DIFFER", "status");
  else if (record.statusCategory === "UNKNOWN") add("UNKNOWN_STATUS", "status");
  if (record.statusCategory === "UNCHECKED") add("STATUS_UNCHECKED", "status");

  if (!isUsable(record.voucherNumber)) add("VOUCHER_NUMBER_MISSING", "voucherNumber");
  if (!isUsable(record.voucherDate)) add("VOUCHER_DATE_MISSING", "voucherDate");
  if (!isUsable(record.createdAt)) add("CREATED_DATE_MISSING", "createdAt");

  if (financial) {
    if (!isUsable(record.dueDate)) add("DUE_DATE_MISSING", "dueDate");
    if (record.dueDateConfidence === "POSSIBLE_DEFAULT") add("DUE_DATE_EQUALS_VOUCHER_DATE", "dueDate");
    if (record.currency.quality === "CONFLICT") add("CURRENCY_SOURCES_DIFFER", "currency");
    else if (!isUsable(record.currency)) add("CURRENCY_MISSING", "currency");
    if (record.grossCents.quality === "CONFLICT") add("GROSS_SOURCES_DIFFER", "grossCents");
    else if (!isUsable(record.grossCents)) add("GROSS_MISSING", "grossCents");
    if (record.openCents.quality === "CONFLICT") add("OPEN_AMOUNT_SOURCES_DIFFER", "openCents");
    else if (!isUsable(record.openCents)) add("OPEN_AMOUNT_MISSING", "openCents");

    if (record.provenance.detail === "FETCHED") {
      if (record.taxCents.quality === "PLACEHOLDER") add("TAX_PLACEHOLDER", "taxCents");
      else if (!isUsable(record.taxCents)) add("TAX_MISSING", "taxCents");
      if (!isUsable(record.netCents)) add("NET_MISSING", "netCents");
      const items = record.lineItems.value;
      const bookkeeping = detailSourceFor(record.voucherType)?.source === "voucher";
      if (bookkeeping && items !== null && items.length === 0) add("LINE_ITEMS_MISSING", "lineItems");
      if (items?.some((li) => li.categoryId.quality === "STRUCTURED" && !isUsable(li.categoryName))) {
        add("CATEGORY_UNRESOLVED", "lineItems");
      }
      const files = record.attachments.value;
      if (files !== null && files.length === 0) add("ATTACHMENT_MISSING", "attachments");
    }
    if (record.provenance.detail === "NOT_FETCHED") add("DETAIL_NOT_FETCHED");
    if (record.provenance.detail === "FAILED") add("DETAIL_FETCH_FAILED");

    if (!isUsable(record.counterparty.contactId)) add("CONTACT_ID_MISSING", "counterparty");
    if (record.counterparty.matchKeyBasis === "NONE") add("COUNTERPARTY_UNIDENTIFIED", "counterparty");
    if (record.role === "CREDIT_NOTE") add("CREDIT_NOTE_SIGN_UNVERIFIED", "grossCents");
    if (record.role === "DOWN_PAYMENT_INVOICE") add("DOWN_PAYMENT_DOUBLE_COUNT_RISK", "grossCents");

    if (record.payment.availability === "NOT_AVAILABLE") add("PAYMENT_NOT_AVAILABLE", "payment");
    if (record.payment.availability === "FETCH_FAILED") add("PAYMENT_FETCH_FAILED", "payment");

    if (record.provenance.attachments === "SKIPPED") add("ATTACHMENT_NOT_INSPECTED", "attachments");
    for (const a of record.attachments.value ?? []) {
      const status = a.inspection?.status;
      if (status === "ocr_required" || status === "unsupported_file_type") add("ATTACHMENT_TEXT_UNAVAILABLE", "attachments");
      if (status === "file_too_large") add("ATTACHMENT_TOO_LARGE", "attachments");
      if (status === "parse_error" || status === "parse_timeout") add("ATTACHMENT_PARSE_FAILED", "attachments");
    }
  }

  const seen = new Set<string>();
  const unique = out.filter((i) => {
    const key = `${i.code}|${i.field ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (a.code === b.code ? (a.field ?? "").localeCompare(b.field ?? "") : a.code.localeCompare(b.code)));
  return { ...record, issues: unique };
}

// ---------------------------------------------------------------------------------------------------------
// Counterparty
// ---------------------------------------------------------------------------------------------------------

/** Conservative name key: case-folded, punctuation-insensitive, whitespace-collapsed. */
export function normalizeNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("de-DE")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function buildCounterparty(contactId: FieldValue<string>, name: FieldValue<string>): Counterparty {
  if (isUsable(contactId)) return { contactId, name, matchKey: `id:${contactId.value}`, matchKeyBasis: "CONTACT_ID" };
  const key = isUsable(name) ? normalizeNameKey(name.value) : "";
  return key !== ""
    ? { contactId, name, matchKey: `name:${key}`, matchKeyBasis: "NAME" }
    : { contactId, name, matchKey: null, matchKeyBasis: "NONE" };
}

// ---------------------------------------------------------------------------------------------------------
// Voucherlist row
// ---------------------------------------------------------------------------------------------------------

const NOT_FETCHED_PAYMENT: PaymentInfo = {
  availability: "NOT_FETCHED",
  paymentStatus: missing("DETAIL_NOT_FETCHED"),
  paidDate: missing("DETAIL_NOT_FETCHED"),
  items: missing("DETAIL_NOT_FETCHED"),
};

const NOT_APPLICABLE_PAYMENT: PaymentInfo = {
  availability: "SKIPPED",
  paymentStatus: missing("NOT_APPLICABLE"),
  paidDate: missing("NOT_APPLICABLE"),
  items: missing("NOT_APPLICABLE"),
};

/** Normalize one voucherlist row. Rows without a valid id are rejected (reported, never invented). */
export function normalizeVoucherlistRow(
  raw: unknown,
  index: number,
  ctx: NormalizeContext,
): { record: FinanceRecord } | { rejected: RejectedRow } {
  if (!isObject(raw)) return { rejected: { index, code: "ROW_NOT_AN_OBJECT" } };
  const id = readId(raw.id, "voucherlist");
  if (!isUsable(id)) return { rejected: { index, code: "ROW_ID_INVALID" } };

  const src: Source = "voucherlist";
  const typeField = readCode(raw.voucherType, src);
  const voucherType = isUsable(typeField) ? typeField.value : "";
  const { kind, role } = classifyVoucherType(voucherType);
  const financial = kind === "EXPENSE" || kind === "REVENUE";
  const notFetched = (): FieldValue<never> => missing(financial ? "DETAIL_NOT_FETCHED" : "NOT_APPLICABLE");

  const status = readCode(raw.voucherStatus, src);
  const gross = readAmount(raw.totalAmount, src);
  const open = readAmount(raw.openAmount, src);
  const contactId = readId(raw.contactId, src);
  const name = readShortText(raw.contactName, src, MAX_NAME_CHARS);

  let record: FinanceRecord = {
    schemaVersion: FINANCE_SCHEMA_VERSION,
    id: id.value,
    voucherType,
    kind,
    role,
    voucherNumber: readShortText(raw.voucherNumber, src, MAX_NUMBER_CHARS),
    voucherDate: readDay(raw.voucherDate, src, ctx.timeZone),
    dueDate: readDay(raw.dueDate, src, ctx.timeZone),
    dueDateConfidence: "MISSING",
    createdAt: readInstant(raw.createdDate, src, ctx.timeZone),
    updatedAt: readInstant(raw.updatedDate, src, ctx.timeZone),
    status,
    statusCategory: categorizeStatus(isUsable(status) ? status.value : null).category,
    currency: readCurrency(raw.currency, src),
    grossCents: gross.field,
    netCents: notFetched(),
    taxCents: notFetched(),
    openCents: open.field,
    taxType: notFetched(),
    counterparty: buildCounterparty(contactId, name),
    lineItems: notFetched(),
    payment: financial ? NOT_FETCHED_PAYMENT : NOT_APPLICABLE_PAYMENT,
    attachments: notFetched(),
    archived: readBoolean(raw.archived, src),
    issues: [],
    provenance: {
      sources: [{ source: src, fetchedAt: ctx.fetchedAt }],
      detail: financial ? "NOT_FETCHED" : "NOT_APPLICABLE",
      payment: financial ? "NOT_FETCHED" : "NOT_APPLICABLE",
      attachments: "NOT_FETCHED",
    },
  };
  record = { ...record, dueDateConfidence: dueDateConfidence(record, false) };
  if (gross.precisionReduced) record = addEventIssue(record, "AMOUNT_PRECISION_REDUCED", "grossCents");
  if (open.precisionReduced) record = addEventIssue(record, "AMOUNT_PRECISION_REDUCED", "openCents");
  return { record: recomputeIssues(record) };
}

// ---------------------------------------------------------------------------------------------------------
// Detail merges
// ---------------------------------------------------------------------------------------------------------

function mergeStatus(record: FinanceRecord, incoming: FieldValue<string>): Pick<FinanceRecord, "status" | "statusCategory"> {
  const current = record.status;
  if (!isUsable(incoming)) return { status: current, statusCategory: record.statusCategory };
  if (!isUsable(current) && current.quality !== "CONFLICT") {
    return { status: incoming, statusCategory: categorizeStatus(incoming.value).category };
  }
  // The voucherlist value (current) wins when compatible: it carries the computed "overdue".
  const merged = mergeField(current, incoming, statusesCompatible);
  return merged.quality === "CONFLICT"
    ? { status: merged, statusCategory: "UNKNOWN" }
    : { status: merged, statusCategory: record.statusCategory };
}

/** Instants within one second are the same (the voucherlist truncates milliseconds). */
function instantsEqual(a: string, b: string): boolean {
  return Math.abs(Date.parse(a) - Date.parse(b)) < 1000;
}

/** Prefer the more precise detail instant when both describe the same moment. */
function mergeInstant(current: FieldValue<string>, incoming: FieldValue<string>): FieldValue<string> {
  if (isUsable(current) && isUsable(incoming) && instantsEqual(current.value, incoming.value)) return incoming;
  return mergeField(current, incoming, instantsEqual);
}

function readFileIds(raw: unknown, source: Source): FieldValue<ReadonlyArray<Attachment>> {
  if (raw === undefined || raw === null) return missing("FIELD_ABSENT", source);
  if (!Array.isArray(raw)) return missing("INVALID_TYPE", source);
  const files: Attachment[] = [];
  for (const id of raw) {
    if (typeof id === "string" && ID_PATTERN.test(id)) files.push({ fileId: id, inspection: null });
  }
  return structured(files, source);
}

function finishDetail(record: FinanceRecord, source: Source, ctx: NormalizeContext, paymentTermStated: boolean): FinanceRecord {
  const next: FinanceRecord = {
    ...record,
    provenance: { ...record.provenance, sources: withSource(record, source, ctx.fetchedAt), detail: "FETCHED" },
  };
  return recomputeIssues({ ...next, dueDateConfidence: dueDateConfidence(next, paymentTermStated) });
}

/** Mark the detail fetch as failed (record stays list-based; issue DETAIL_FETCH_FAILED). */
export function markDetailFailed(record: FinanceRecord): FinanceRecord {
  return recomputeIssues({ ...record, provenance: { ...record.provenance, detail: "FAILED" } });
}

/** Merge a bookkeeping voucher (`GET /v1/vouchers/{id}`): purchase/sales invoices and credit notes. */
export function applyVoucherDetail(record: FinanceRecord, raw: unknown, ctx: NormalizeContext): FinanceRecord {
  const src: Source = "voucher";
  if (!isObject(raw)) return markDetailFailed(record);
  if (raw.id !== record.id) return markDetailFailed(addEventIssue(record, "DETAIL_ID_MISMATCH"));

  let r: FinanceRecord = { ...record, ...mergeStatus(record, readCode(raw.voucherStatus, src)) };
  r = {
    ...r,
    voucherNumber: mergeField(r.voucherNumber, readShortText(raw.voucherNumber, src, MAX_NUMBER_CHARS)),
    voucherDate: mergeField(r.voucherDate, readDay(raw.voucherDate, src, ctx.timeZone)),
    dueDate: mergeField(r.dueDate, readDay(raw.dueDate, src, ctx.timeZone)),
    createdAt: mergeInstant(r.createdAt, readInstant(raw.createdDate, src, ctx.timeZone)),
    updatedAt: mergeInstant(r.updatedAt, readInstant(raw.updatedDate, src, ctx.timeZone)),
    archived: mergeField(r.archived, readBoolean(raw.archived, src)),
  };

  const gross = readAmount(raw.totalGrossAmount, src);
  if (gross.precisionReduced) r = addEventIssue(r, "AMOUNT_PRECISION_REDUCED", "grossCents");
  r = { ...r, grossCents: mergeField(r.grossCents, gross.field) };

  const taxType = readCode(raw.taxType, src);
  const basis: LineItem["amountBasis"] = isUsable(taxType)
    ? taxType.value === "gross"
      ? "gross"
      : taxType.value === "net"
        ? "net"
        : "unknown"
    : "unknown";

  // Line items.
  let items: FieldValue<ReadonlyArray<LineItem>>;
  let itemSumAmount = 0;
  let itemSumTax = 0;
  let itemSumsUsable = true;
  if (Array.isArray(raw.voucherItems)) {
    const parsed: LineItem[] = [];
    for (const it of raw.voucherItems) {
      if (!isObject(it)) {
        itemSumsUsable = false;
        continue;
      }
      const amount = readAmount(it.amount, src);
      const tax = readAmount(it.taxAmount, src);
      if (amount.precisionReduced || tax.precisionReduced) r = addEventIssue(r, "AMOUNT_PRECISION_REDUCED", "lineItems");
      if (isUsable(amount.field) && isUsable(tax.field)) {
        itemSumAmount += amount.field.value;
        itemSumTax += tax.field.value;
      } else {
        itemSumsUsable = false;
      }
      parsed.push({
        amountCents: amount.field,
        amountBasis: basis,
        taxCents: tax.field,
        taxRatePercent: readPercent(it.taxRatePercent, src),
        categoryId: readId(it.categoryId, src),
        categoryName: missing("CATEGORIES_NOT_LOADED"),
        categoryType: missing("CATEGORIES_NOT_LOADED"),
      });
    }
    items = structured(parsed, src);
  } else {
    items = missing(raw.voucherItems === undefined ? "FIELD_ABSENT" : "INVALID_TYPE", src);
  }

  // Tax: a 0 on an unreviewed (or status-unknown) voucher without line items is Lexware's placeholder,
  // not a tax amount — treating it as 0 would overstate net and understate input VAT.
  const taxRead = readAmount(raw.totalTaxAmount, src);
  if (taxRead.precisionReduced) r = addEventIssue(r, "AMOUNT_PRECISION_REDUCED", "taxCents");
  const noItems = items.value !== null && items.value.length === 0;
  const notReviewed = r.statusCategory === "UNCHECKED" || r.statusCategory === "UNKNOWN";
  let tax: FieldValue<number> = taxRead.field;
  if (notReviewed && noItems && isUsable(taxRead.field) && taxRead.field.value === 0) {
    tax = placeholder(0, "UNCHECKED_TAX_PLACEHOLDER", src);
  }

  // Consistency of line items with the totals.
  const lineItems = items.value;
  if (lineItems !== null && lineItems.length > 0 && itemSumsUsable && isUsable(r.grossCents)) {
    const grossFromItems = basis === "gross" ? itemSumAmount : basis === "net" ? itemSumAmount + itemSumTax : null;
    const taxMismatch = isUsable(tax) && tax.value !== itemSumTax;
    if ((grossFromItems !== null && grossFromItems !== r.grossCents.value) || taxMismatch) {
      r = addEventIssue(r, "LINE_ITEM_SUM_MISMATCH", "lineItems");
    }
  }

  const net: FieldValue<number> =
    isUsable(r.grossCents) && isUsable(tax)
      ? derived(r.grossCents.value - tax.value, "GROSS_MINUS_TAX")
      : missing(tax.quality === "PLACEHOLDER" ? "UNCHECKED_TAX_PLACEHOLDER" : (tax.reason ?? "FIELD_ABSENT"), src);

  const contactId = mergeField(r.counterparty.contactId, readId(raw.contactId, src));
  r = {
    ...r,
    taxType,
    taxCents: tax,
    netCents: net,
    lineItems: items,
    attachments: readFileIds(raw.files, src),
    counterparty: buildCounterparty(contactId, r.counterparty.name),
  };
  return finishDetail(r, src, ctx, false);
}

/** Merge a sales document detail (`/v1/invoices`, `/v1/credit-notes`, `/v1/down-payment-invoices`). */
export function applySalesDocumentDetail(
  record: FinanceRecord,
  raw: unknown,
  source: Extract<Source, "invoice" | "credit-note" | "down-payment-invoice">,
  ctx: NormalizeContext,
): FinanceRecord {
  if (!isObject(raw)) return markDetailFailed(record);
  if (raw.id !== record.id) return markDetailFailed(addEventIssue(record, "DETAIL_ID_MISMATCH"));

  let r: FinanceRecord = { ...record, ...mergeStatus(record, readCode(raw.voucherStatus, source)) };
  r = {
    ...r,
    voucherNumber: mergeField(r.voucherNumber, readShortText(raw.voucherNumber, source, MAX_NUMBER_CHARS)),
    voucherDate: mergeField(r.voucherDate, readDay(raw.voucherDate, source, ctx.timeZone)),
    dueDate: mergeField(r.dueDate, readDay(raw.dueDate, source, ctx.timeZone)),
    createdAt: mergeInstant(r.createdAt, readInstant(raw.createdDate, source, ctx.timeZone)),
    updatedAt: mergeInstant(r.updatedAt, readInstant(raw.updatedDate, source, ctx.timeZone)),
    archived: mergeField(r.archived, readBoolean(raw.archived, source)),
  };

  const totals = isObject(raw.totalPrice) ? raw.totalPrice : {};
  const gross = readAmount(totals.totalGrossAmount, source);
  const net = readAmount(totals.totalNetAmount, source);
  const tax = readAmount(totals.totalTaxAmount, source);
  for (const [field, read] of [
    ["grossCents", gross],
    ["netCents", net],
    ["taxCents", tax],
  ] as const) {
    if (read.precisionReduced) r = addEventIssue(r, "AMOUNT_PRECISION_REDUCED", field);
  }
  if (isUsable(gross.field) && isUsable(net.field) && isUsable(tax.field)) {
    if (net.field.value + tax.field.value !== gross.field.value) r = addEventIssue(r, "TOTALS_INCONSISTENT", "grossCents");
  }

  const taxConditions = isObject(raw.taxConditions) ? raw.taxConditions : {};
  const taxType = readCode(taxConditions.taxType, source);
  const basis: LineItem["amountBasis"] = isUsable(taxType) && (taxType.value === "gross" || taxType.value === "net") ? taxType.value : "unknown";

  // Sales line items carry no posting category; amounts are per line (net or gross per taxType).
  let items: FieldValue<ReadonlyArray<LineItem>>;
  if (Array.isArray(raw.lineItems)) {
    const parsed: LineItem[] = [];
    for (const it of raw.lineItems) {
      if (!isObject(it) || it.lineItemAmount === undefined) continue; // text-only lines carry no amount
      const amount = readAmount(it.lineItemAmount, source);
      if (amount.precisionReduced) r = addEventIssue(r, "AMOUNT_PRECISION_REDUCED", "lineItems");
      const unitPrice = isObject(it.unitPrice) ? it.unitPrice : {};
      parsed.push({
        amountCents: amount.field,
        amountBasis: basis,
        taxCents: missing("NOT_APPLICABLE", source),
        taxRatePercent: readPercent(unitPrice.taxRatePercentage, source),
        categoryId: missing("NOT_APPLICABLE", source),
        categoryName: missing("NOT_APPLICABLE", source),
        categoryType: missing("NOT_APPLICABLE", source),
      });
    }
    items = structured(parsed, source);
  } else {
    items = missing(raw.lineItems === undefined ? "FIELD_ABSENT" : "INVALID_TYPE", source);
  }

  const address = isObject(raw.address) ? raw.address : {};
  const contactId = mergeField(r.counterparty.contactId, readId(address.contactId, source));
  const name = isUsable(r.counterparty.name) ? r.counterparty.name : readShortText(address.name, source, MAX_NAME_CHARS);

  const files = isObject(raw.files) ? raw.files : {};
  const documentFileId = readId(files.documentFileId, source);
  const attachments: FieldValue<ReadonlyArray<Attachment>> = isUsable(documentFileId)
    ? structured([{ fileId: documentFileId.value, inspection: null }], source)
    : missing(documentFileId.reason ?? "FIELD_ABSENT", source);

  const paymentConditions = isObject(raw.paymentConditions) ? raw.paymentConditions : {};
  const paymentTermStated =
    typeof paymentConditions.paymentTermDuration === "number" && Number.isInteger(paymentConditions.paymentTermDuration);

  r = {
    ...r,
    currency: mergeField(r.currency, readCurrency(totals.currency, source)),
    grossCents: mergeField(r.grossCents, gross.field),
    netCents: net.field,
    taxCents: tax.field,
    taxType,
    lineItems: items,
    attachments,
    counterparty: buildCounterparty(contactId, name),
  };
  return finishDetail(r, source, ctx, paymentTermStated);
}

// ---------------------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------------------

/** Merge `GET /v1/payments/{id}`. */
export function applyPayment(record: FinanceRecord, raw: unknown, ctx: NormalizeContext): FinanceRecord {
  const src: Source = "payment";
  if (!isObject(raw)) return markPaymentFailed(record);
  let r = record;
  const open = readAmount(raw.openAmount, src);
  if (open.precisionReduced) r = addEventIssue(r, "AMOUNT_PRECISION_REDUCED", "openCents");

  let items: FieldValue<ReadonlyArray<PaymentItem>>;
  if (Array.isArray(raw.paymentItems)) {
    const parsed: PaymentItem[] = [];
    for (const it of raw.paymentItems) {
      if (!isObject(it)) continue;
      const amount = readAmount(it.amount, src);
      if (amount.precisionReduced) r = addEventIssue(r, "AMOUNT_PRECISION_REDUCED", "payment");
      parsed.push({
        type: readShortText(it.paymentItemType, src, MAX_CODE_CHARS),
        postingDate: readDay(it.postingDate, src, ctx.timeZone),
        amountCents: amount.field,
        currency: readCurrency(it.currency, src),
      });
    }
    items = structured(parsed, src);
  } else {
    items = missing(raw.paymentItems === undefined ? "FIELD_ABSENT" : "INVALID_TYPE", src);
  }

  r = {
    ...r,
    openCents: mergeField(r.openCents, open.field),
    currency: mergeField(r.currency, readCurrency(raw.currency, src)),
    payment: {
      availability: "AVAILABLE",
      paymentStatus: readShortText(raw.paymentStatus, src, MAX_CODE_CHARS),
      paidDate: readDay(raw.paidDate, src, ctx.timeZone),
      items,
    },
    provenance: { ...r.provenance, sources: withSource(r, src, ctx.fetchedAt), payment: "FETCHED" },
  };
  return recomputeIssues(r);
}

function paymentState(record: FinanceRecord, availability: PaymentInfo["availability"], reason: Reason, fetch: FinanceRecord["provenance"]["payment"]) {
  return recomputeIssues({
    ...record,
    payment: { availability, paymentStatus: missing(reason, "payment"), paidDate: missing(reason, "payment"), items: missing(reason, "payment") },
    provenance: { ...record.provenance, payment: fetch },
  });
}

/** Lexware answered that it has no payment information for this voucher (HTTP 406). */
export function markPaymentNotAvailable(record: FinanceRecord): FinanceRecord {
  return paymentState(record, "NOT_AVAILABLE", "PAYMENT_NOT_AVAILABLE", "FETCHED");
}

export function markPaymentFailed(record: FinanceRecord): FinanceRecord {
  return paymentState(record, "FETCH_FAILED", "DETAIL_FETCH_FAILED", "FAILED");
}

/** Payment information was deliberately not requested (e.g. status unchecked/draft/voided). */
export function markPaymentSkipped(record: FinanceRecord): FinanceRecord {
  return paymentState(record, "SKIPPED", "NOT_APPLICABLE", "SKIPPED");
}

// ---------------------------------------------------------------------------------------------------------
// Posting categories
// ---------------------------------------------------------------------------------------------------------

export type CategoryIndex = ReadonlyMap<string, { name: FieldValue<string>; type: FieldValue<CategoryType> }>;

/** Build an id-keyed index from `GET /v1/posting-categories` (names are not unique; ids are). */
export function buildCategoryIndex(raw: unknown): CategoryIndex {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.data) ? raw.data : [];
  const index = new Map<string, { name: FieldValue<string>; type: FieldValue<CategoryType> }>();
  for (const c of list) {
    if (!isObject(c) || typeof c.id !== "string" || !ID_PATTERN.test(c.id)) continue;
    const type: FieldValue<CategoryType> =
      c.type === "income" || c.type === "outgo"
        ? structured(c.type, "posting-categories")
        : missing(c.type === undefined ? "FIELD_ABSENT" : "INVALID_FORMAT", "posting-categories");
    index.set(c.id, { name: readShortText(c.name, "posting-categories", MAX_NAME_CHARS), type });
  }
  return index;
}

/** Resolve line-item category ids to names/types. `index === null` means categories could not be loaded. */
export function applyCategories(record: FinanceRecord, index: CategoryIndex | null): FinanceRecord {
  const items = record.lineItems.value;
  if (items === null || items.length === 0) return record;
  const resolved = items.map((li): LineItem => {
    if (!isUsable(li.categoryId)) return li;
    if (index === null) return { ...li, categoryName: missing("CATEGORIES_NOT_LOADED"), categoryType: missing("CATEGORIES_NOT_LOADED") };
    const hit = index.get(li.categoryId.value);
    return hit
      ? { ...li, categoryName: hit.name, categoryType: hit.type }
      : { ...li, categoryName: missing("CATEGORY_UNRESOLVED", "posting-categories"), categoryType: missing("CATEGORY_UNRESOLVED", "posting-categories") };
  });
  return recomputeIssues({ ...record, lineItems: { ...record.lineItems, value: resolved } });
}

// ---------------------------------------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------------------------------------

export interface InspectionInput {
  readonly fileId: string;
  readonly status: AttachmentInspection["status"];
  readonly sha256: string | null;
  readonly byteLength: number | null;
  readonly mimeType: string | null;
  readonly pageCount: number | null;
  readonly text: string;
  readonly textAvailable: boolean;
  readonly textTruncated: boolean;
}

/** Attach a file inspection result (text stays UNTRUSTED; it is already cleaned by the inspector). */
export function applyAttachmentInspection(record: FinanceRecord, result: InspectionInput, ctx: NormalizeContext): FinanceRecord {
  const files = record.attachments.value;
  if (files === null || !files.some((f) => f.fileId === result.fileId)) return record;
  const inspection: AttachmentInspection = {
    status: result.status,
    sha256: result.sha256,
    byteLength: result.byteLength,
    mimeType: result.mimeType,
    pageCount: result.pageCount,
    text: result.textAvailable ? result.text : null,
    textTruncated: result.textTruncated,
  };
  const next = files.map((f) => (f.fileId === result.fileId ? { ...f, inspection } : f));
  const sources = record.provenance.sources.some((s) => s.source === "file")
    ? record.provenance.sources
    : withSource(record, "file", ctx.fetchedAt);
  return recomputeIssues({
    ...record,
    attachments: { ...record.attachments, value: next },
    provenance: { ...record.provenance, sources },
  });
}

/** Record whether attachment inspection ran completely, partially (SKIPPED) or failed. */
export function markAttachmentState(record: FinanceRecord, state: FinanceRecord["provenance"]["attachments"]): FinanceRecord {
  return recomputeIssues({ ...record, provenance: { ...record.provenance, attachments: state } });
}
