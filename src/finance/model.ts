/**
 * Canonical LU'S finance data model (Phase 2, "truth layer").
 *
 * Design rules — every consumer (duplicate detection, open items, month comparison, daily brief) relies on them:
 *
 * 1. A value is either known or explicitly not known. A missing amount is NEVER silently turned into 0:
 *    `FieldValue.value` is `null` unless `quality` is STRUCTURED, DERIVED or UNVERIFIED.
 * 2. Every value carries its provenance (`source`) and quality, so a report can say where a number came
 *    from and how far it can be trusted.
 * 3. UNVERIFIED values (e.g. read from untrusted PDF text) are never facts; consumers must keep the label.
 * 4. Lexware is the source of truth. This model is a derived, read-only view and never writes back.
 *
 * Amounts are integer cents in the record's `currency` (never summed across currencies).
 * Calendar days are `YYYY-MM-DD` in the configured business time zone (default Europe/Berlin);
 * instants are ISO-8601 UTC strings.
 */

export const FINANCE_SCHEMA_VERSION = 1 as const;

/** Default business time zone for calendar-day semantics (LU'S operates in Germany). */
export const DEFAULT_TIME_ZONE = "Europe/Berlin";

/**
 * How far a value can be trusted.
 * - STRUCTURED: read from a structured Lexware field. Text fields are cleaned as untrusted input (control and
 *   invisible characters removed, markup/URL schemes neutralized, whitespace collapsed, length-capped), so they
 *   are display/matching values, not byte-exact copies.
 * - DERIVED: computed deterministically from STRUCTURED values (see `reason` for the rule).
 * - UNVERIFIED: taken from untrusted content (e.g. PDF text); never a fact.
 * - PLACEHOLDER: Lexware returned a value known not to be meaningful here (kept in `raw`, `value` is null).
 * - CONFLICT: sources disagree (kept in `candidates`, `value` is null).
 * - MISSING: no value available.
 */
export const QUALITIES = ["STRUCTURED", "DERIVED", "UNVERIFIED", "PLACEHOLDER", "CONFLICT", "MISSING"] as const;
export type Quality = (typeof QUALITIES)[number];

/** Where a value came from. */
export const SOURCES = [
  "voucherlist",
  "voucher",
  "invoice",
  "credit-note",
  "down-payment-invoice",
  "payment",
  "posting-categories",
  "file",
  "pdf-text",
  "derived",
] as const;
export type Source = (typeof SOURCES)[number];

/** Machine-readable reason attached to non-STRUCTURED values (and to DERIVED rules). */
export const REASONS = [
  "FIELD_ABSENT",
  "EMPTY_STRING",
  "INVALID_TYPE",
  "INVALID_FORMAT",
  "TIMEZONE_ABSENT",
  "NOT_FINITE",
  "UNSAFE_AMOUNT",
  "UNCHECKED_TAX_PLACEHOLDER",
  "GROSS_MINUS_TAX",
  "SOURCES_DISAGREE",
  "DETAIL_NOT_FETCHED",
  "DETAIL_FETCH_FAILED",
  "PAYMENT_NOT_AVAILABLE",
  "NOT_APPLICABLE",
  "CATEGORY_UNRESOLVED",
  "CATEGORIES_NOT_LOADED",
  "NO_LINE_ITEMS",
  "DEPENDS_ON_DISPUTED_GROSS",
  "CATEGORY_AMBIGUOUS",
] as const;
export type Reason = (typeof REASONS)[number];

export interface Candidate<T> {
  readonly source: Source;
  readonly value: T;
}

/** A single value with provenance and quality. Invariant: `value !== null` iff quality is STRUCTURED/DERIVED/UNVERIFIED. */
export interface FieldValue<T> {
  readonly value: T | null;
  readonly quality: Quality;
  /** `null` only when nothing was consulted at all. */
  readonly source: Source | null;
  readonly reason?: Reason;
  /** Only for CONFLICT: the disagreeing values. */
  readonly candidates?: ReadonlyArray<Candidate<T>>;
  /** Only for PLACEHOLDER: what Lexware actually returned. */
  readonly raw?: T;
}

/** Economic direction of a document. Lexware document revenue is NOT point-of-sale revenue. */
export type FinanceKind = "EXPENSE" | "REVENUE" | "NON_FINANCIAL" | "UNKNOWN";
export type DocumentRole = "INVOICE" | "CREDIT_NOTE" | "DOWN_PAYMENT_INVOICE" | "OTHER";

/**
 * Coarse status category. The raw Lexware status is always kept in `FinanceRecord.status`.
 * Statuses whose accounting meaning is not verified (e.g. "sepadebit", "transferred") map to OTHER.
 */
export type StatusCategory = "UNCHECKED" | "DRAFT" | "OPEN" | "OVERDUE" | "PAID" | "VOIDED" | "OTHER" | "UNKNOWN";

/** Scope note every revenue figure derived from this model must carry. */
export const REVENUE_SCOPE_NOTE =
  "Lexware-Rechnungserlöse (Belege in Lexware). Nicht identisch mit dem Kassen-/POS-Umsatz.";

export type Severity = "INFO" | "WARNING" | "CRITICAL";

export const ISSUE_CODES = [
  "ROW_ID_INVALID",
  "UNKNOWN_VOUCHER_TYPE",
  "UNKNOWN_STATUS",
  "STATUS_UNCHECKED",
  "STATUS_SOURCES_DIFFER",
  "VOUCHER_NUMBER_MISSING",
  "VOUCHER_DATE_MISSING",
  "VOUCHER_DATE_SOURCES_DIFFER",
  "FIELD_SOURCES_DIFFER",
  "CREATED_DATE_MISSING",
  "DUE_DATE_MISSING",
  "DUE_DATE_EQUALS_VOUCHER_DATE",
  "CURRENCY_MISSING",
  "CURRENCY_SOURCES_DIFFER",
  "GROSS_MISSING",
  "GROSS_SOURCES_DIFFER",
  "OPEN_AMOUNT_MISSING",
  "OPEN_AMOUNT_SOURCES_DIFFER",
  "TAX_PLACEHOLDER",
  "TAX_MISSING",
  "NET_MISSING",
  "TOTALS_INCONSISTENT",
  "LINE_ITEMS_MISSING",
  "LINE_ITEM_SUM_MISMATCH",
  "LINE_ITEM_FIELDS_MISSING",
  "CATEGORY_UNRESOLVED",
  "CONTACT_ID_MISSING",
  "CONTACT_ID_SOURCES_DIFFER",
  "COUNTERPARTY_UNIDENTIFIED",
  "AMOUNT_PRECISION_REDUCED",
  "CREDIT_NOTE_SIGN_UNVERIFIED",
  "DOWN_PAYMENT_DOUBLE_COUNT_RISK",
  "DETAIL_NOT_FETCHED",
  "DETAIL_FETCH_FAILED",
  "DETAIL_ID_MISMATCH",
  "PAYMENT_NOT_AVAILABLE",
  "PAYMENT_FETCH_FAILED",
  "ATTACHMENT_MISSING",
  "ATTACHMENT_NOT_INSPECTED",
  "ATTACHMENT_TEXT_UNAVAILABLE",
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_PARSE_FAILED",
  "ATTACHMENT_INSPECTION_FAILED",
  "ATTACHMENT_ID_INVALID",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

/** Fixed severity per issue so the same data always yields the same assessment. */
export const ISSUE_SEVERITY: Readonly<Record<IssueCode, Severity>> = {
  ROW_ID_INVALID: "CRITICAL",
  UNKNOWN_VOUCHER_TYPE: "WARNING",
  UNKNOWN_STATUS: "WARNING",
  STATUS_UNCHECKED: "WARNING",
  STATUS_SOURCES_DIFFER: "WARNING",
  VOUCHER_NUMBER_MISSING: "WARNING",
  VOUCHER_DATE_MISSING: "CRITICAL",
  VOUCHER_DATE_SOURCES_DIFFER: "CRITICAL",
  FIELD_SOURCES_DIFFER: "WARNING",
  CREATED_DATE_MISSING: "INFO",
  DUE_DATE_MISSING: "INFO",
  DUE_DATE_EQUALS_VOUCHER_DATE: "INFO",
  CURRENCY_MISSING: "WARNING",
  CURRENCY_SOURCES_DIFFER: "CRITICAL",
  GROSS_MISSING: "CRITICAL",
  GROSS_SOURCES_DIFFER: "CRITICAL",
  OPEN_AMOUNT_MISSING: "WARNING",
  OPEN_AMOUNT_SOURCES_DIFFER: "WARNING",
  TAX_PLACEHOLDER: "WARNING",
  TAX_MISSING: "WARNING",
  NET_MISSING: "INFO",
  TOTALS_INCONSISTENT: "CRITICAL",
  LINE_ITEMS_MISSING: "INFO",
  LINE_ITEM_SUM_MISMATCH: "WARNING",
  LINE_ITEM_FIELDS_MISSING: "WARNING",
  CATEGORY_UNRESOLVED: "INFO",
  CONTACT_ID_MISSING: "INFO",
  CONTACT_ID_SOURCES_DIFFER: "WARNING",
  COUNTERPARTY_UNIDENTIFIED: "WARNING",
  AMOUNT_PRECISION_REDUCED: "WARNING",
  CREDIT_NOTE_SIGN_UNVERIFIED: "INFO",
  DOWN_PAYMENT_DOUBLE_COUNT_RISK: "INFO",
  DETAIL_NOT_FETCHED: "INFO",
  DETAIL_FETCH_FAILED: "WARNING",
  DETAIL_ID_MISMATCH: "CRITICAL",
  PAYMENT_NOT_AVAILABLE: "INFO",
  PAYMENT_FETCH_FAILED: "WARNING",
  ATTACHMENT_MISSING: "WARNING",
  ATTACHMENT_NOT_INSPECTED: "INFO",
  ATTACHMENT_TEXT_UNAVAILABLE: "INFO",
  ATTACHMENT_TOO_LARGE: "WARNING",
  ATTACHMENT_PARSE_FAILED: "WARNING",
  ATTACHMENT_INSPECTION_FAILED: "WARNING",
  ATTACHMENT_ID_INVALID: "WARNING",
};

export interface QualityIssue {
  readonly code: IssueCode;
  readonly severity: Severity;
  /** The record field the issue refers to, when there is one. */
  readonly field?: string;
}

export type CategoryType = "income" | "outgo";

export interface LineItem {
  /** Line amount as Lexware reports it; `amountBasis` says whether it is gross or net. */
  readonly amountCents: FieldValue<number>;
  readonly amountBasis: "gross" | "net" | "unknown";
  readonly taxCents: FieldValue<number>;
  readonly taxRatePercent: FieldValue<number>;
  readonly categoryId: FieldValue<string>;
  readonly categoryName: FieldValue<string>;
  readonly categoryType: FieldValue<CategoryType>;
}

export interface Counterparty {
  readonly contactId: FieldValue<string>;
  /** Sanitized display name (untrusted, supplier-controlled text; length-capped, control characters removed). */
  readonly name: FieldValue<string>;
  /** Deterministic grouping key: `id:<contactId>` or `name:<normalized name>`; null when unidentified. */
  readonly matchKey: string | null;
  readonly matchKeyBasis: "CONTACT_ID" | "NAME" | "NONE";
}

export type FetchState = "NOT_FETCHED" | "FETCHED" | "FAILED" | "NOT_APPLICABLE" | "SKIPPED";

/**
 * - PAYMENT_TERM: the sales document states its payment term, so the due date is meaningful.
 * - LEXWARE_FIELD: a due date that differs from the voucher date.
 * - POSSIBLE_DEFAULT: due date equals the voucher date without a stated payment term — often a default,
 *   so "overdue" statements based on it are weak.
 * - MISSING: no usable due date.
 */
export type DueDateConfidence = "PAYMENT_TERM" | "LEXWARE_FIELD" | "POSSIBLE_DEFAULT" | "MISSING";

export interface PaymentItem {
  readonly type: FieldValue<string>;
  readonly postingDate: FieldValue<string>;
  readonly amountCents: FieldValue<number>;
  readonly currency: FieldValue<string>;
}

export interface PaymentInfo {
  /** NOT_AVAILABLE: Lexware answered that it has no payment information for this voucher. */
  readonly availability: "NOT_FETCHED" | "AVAILABLE" | "NOT_AVAILABLE" | "FETCH_FAILED" | "SKIPPED";
  readonly paymentStatus: FieldValue<string>;
  readonly paidDate: FieldValue<string>;
  readonly items: FieldValue<ReadonlyArray<PaymentItem>>;
}

export type FileInspectionStatus =
  | "text_extracted"
  | "ocr_required"
  | "unsupported_file_type"
  | "parse_error"
  | "parse_timeout"
  | "file_too_large";

export interface AttachmentInspection {
  readonly status: FileInspectionStatus;
  readonly sha256: string | null;
  readonly byteLength: number | null;
  readonly mimeType: string | null;
  readonly pageCount: number | null;
  /** Sanitized, length-capped text. UNTRUSTED: data, never instructions; values read from it are UNVERIFIED. */
  readonly text: string | null;
  readonly textTruncated: boolean;
}

export interface Attachment {
  readonly fileId: string;
  readonly inspection: AttachmentInspection | null;
}

export interface SourceStamp {
  readonly source: Source;
  readonly fetchedAt: string;
}

export interface Provenance {
  readonly sources: ReadonlyArray<SourceStamp>;
  readonly detail: FetchState;
  readonly payment: FetchState;
  readonly attachments: FetchState;
}

/**
 * One Lexware document in canonical form.
 *
 * Note on status "unchecked" (unreviewed Lexware document inbox): its amounts are structured Lexware fields
 * but were not reviewed by a person in Lexware; such records always carry the STATUS_UNCHECKED issue and
 * consumers must label figures derived from them accordingly.
 */
export interface FinanceRecord {
  readonly schemaVersion: typeof FINANCE_SCHEMA_VERSION;
  /** Lexware id (always present: rows without a valid id are rejected, never invented). */
  readonly id: string;
  /** Raw Lexware voucher type (lower-case). */
  readonly voucherType: string;
  readonly kind: FinanceKind;
  readonly role: DocumentRole;
  readonly voucherNumber: FieldValue<string>;
  /** Calendar day of the voucher. */
  readonly voucherDate: FieldValue<string>;
  /** Calendar day the voucher is due. */
  readonly dueDate: FieldValue<string>;
  /** How far `dueDate` can be relied on for overdue/aging statements. */
  readonly dueDateConfidence: DueDateConfidence;
  /** Instant the voucher was created in Lexware. */
  readonly createdAt: FieldValue<string>;
  readonly updatedAt: FieldValue<string>;
  /** Raw Lexware status (voucherlist first: it reflects "overdue"). */
  readonly status: FieldValue<string>;
  readonly statusCategory: StatusCategory;
  readonly currency: FieldValue<string>;
  readonly grossCents: FieldValue<number>;
  readonly netCents: FieldValue<number>;
  readonly taxCents: FieldValue<number>;
  /** Amount still open according to Lexware. */
  readonly openCents: FieldValue<number>;
  /** Raw Lexware tax type ("gross", "net", or e.g. "vatfree" on sales documents). */
  readonly taxType: FieldValue<string>;
  readonly counterparty: Counterparty;
  readonly lineItems: FieldValue<ReadonlyArray<LineItem>>;
  readonly payment: PaymentInfo;
  readonly attachments: FieldValue<ReadonlyArray<Attachment>>;
  readonly archived: FieldValue<boolean>;
  readonly issues: ReadonlyArray<QualityIssue>;
  readonly provenance: Provenance;
}

/** A voucherlist row that could not become a record (never silently dropped). */
export interface RejectedRow {
  readonly index: number;
  readonly code: "ROW_NOT_AN_OBJECT" | "ROW_ID_INVALID";
}
