/**
 * Deterministic LU'S Finance Daily brief.
 *
 * - Built only from the analyses in this folder; no LLM text, no clock (reference day and fetch time are input),
 *   no locale-dependent formatting (own German number format), fixed ordering and list limits. The same input
 *   always renders byte-identical text.
 * - Wording rules: Lexware invoice revenue is never called "Umsatz" (only the scope note mentions the POS revenue it
 *   is not), and states are phrased as "laut Lexware" — never "wurde bezahlt/gebucht/gelöscht/überwiesen".
 * - Lexware texts (supplier names, voucher numbers) are untrusted: shortened and enclosed in «» with any « » inside
 *   replaced, so they cannot fake the delimiters.
 */
import { addCents } from "./amounts.js";
import { type DayRange, formatDayDe } from "./calendar.js";
import type { DataQualityFindingCode, DataQualityGrade, DataQualityReport } from "./data-quality.js";
import type { DuplicateAnalysis, DuplicateRuleId, PairResult } from "./duplicates.js";
import { compareCodeUnits, grossAmount, uniqueById } from "./facts.js";
import { type FinanceRecord, REVENUE_SCOPE_NOTE } from "./model.js";
import type { OpenItem, OpenItemReason, OpenItemsAnalysis, StatusTotal } from "./open-items.js";
import type { Anomaly, CurrencySum, MoneyComparison, NotEvaluated, PeriodComparison } from "./periods.js";
import { isUsable } from "./values.js";

export type BriefStatus = "GRÜN" | "GELB" | "ROT";

export const BRIEF_REASONS = [
  "LIST_INCOMPLETE",
  "DATA_QUALITY_POOR",
  "EXACT_DUPLICATE_REVIEWED",
  "DATA_QUALITY_LIMITED",
  "DUPLICATE_CANDIDATES",
  "DUPLICATE_ANALYSIS_INCOMPLETE",
  "OVERDUE_CONFIRMED",
  "POSSIBLY_OVERDUE",
  "DUE_DATE_UNRELIABLE",
  "STATUS_CONTRADICTION",
  "ANOMALY",
  "UNREVIEWED_DOCUMENTS",
  "NO_DATA",
] as const;
export type BriefReason = (typeof BRIEF_REASONS)[number];

const RED_REASONS: ReadonlySet<BriefReason> = new Set<BriefReason>(["LIST_INCOMPLETE", "DATA_QUALITY_POOR", "EXACT_DUPLICATE_REVIEWED"]);

export interface BriefLoadInfo {
  readonly list: "COMPLETE" | "PARTIAL" | "FAILED";
  readonly listReason: string;
  readonly window: DayRange;
  readonly budgetExhausted: boolean;
  readonly errors: number;
}

export interface BriefInput {
  /** Reference day (YYYY-MM-DD, business time zone). */
  readonly asOf: string;
  readonly timeZone: string;
  /** ISO instant of the Lexware read (shown as given, never taken from a clock here). */
  readonly fetchedAt: string;
  readonly load: BriefLoadInfo;
  readonly dataQuality: DataQualityReport;
  readonly periods: PeriodComparison;
  readonly openItems: OpenItemsAnalysis;
  readonly duplicates: DuplicateAnalysis;
  /** The analysed records (used to describe duplicate pairs). */
  readonly records: ReadonlyArray<FinanceRecord>;
  /** Entries listed per section before "… und N weitere" (default 5). */
  readonly maxListItems?: number;
}

export interface AttentionItem {
  readonly reason: BriefReason;
  readonly text: string;
}

export interface DailyBrief {
  readonly status: BriefStatus;
  readonly statusReasons: ReadonlyArray<BriefReason>;
  readonly ownerAttention: ReadonlyArray<AttentionItem>;
  readonly noActionNeeded: ReadonlyArray<string>;
  readonly text: string;
}

// ---------------------------------------------------------------------------------------------------------
// Formatting (deterministic, no locale API)
// ---------------------------------------------------------------------------------------------------------

/** 123456 → "1.234,56 €" (other currencies keep their ISO code); null → "nicht berechenbar". */
export function formatMoney(cents: number | null, currency = "EUR"): string {
  if (cents === null || !Number.isSafeInteger(cents)) return "nicht berechenbar";
  const negative = cents < 0;
  const abs = negative ? -cents : cents;
  const euros = Math.floor(abs / 100).toString();
  const rest = (abs % 100).toString().padStart(2, "0");
  const grouped = euros.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  // Currencies are validated ISO codes upstream; anything else is never printed (it could carry forged text).
  const unit = currency === "EUR" ? "€" : /^[A-Z]{3}$/.test(currency) ? currency : "(Währung ungültig)";
  return `${negative ? "-" : ""}${grouped},${rest} ${unit}`;
}

/** A configured percentage in German notation, e.g. 12.5 → "12,5". */
export function formatPercentNumber(value: number): string {
  return String(value).replace(".", ",");
}

/** Signed money difference, e.g. "+1.234,56 €" / "-5,00 €" / "±0,00 €". */
export function formatMoneyDelta(cents: number | null, currency = "EUR"): string {
  if (cents === null || !Number.isSafeInteger(cents)) return "nicht berechenbar";
  if (cents === 0) return `±${formatMoney(0, currency)}`;
  return cents > 0 ? `+${formatMoney(cents, currency)}` : formatMoney(cents, currency);
}

/** Tenths of a percent → "+12,3 %". */
export function formatPercentTenths(tenths: number): string {
  const sign = tenths > 0 ? "+" : tenths < 0 ? "-" : "±";
  const abs = Math.abs(tenths);
  return `${sign}${Math.floor(abs / 10)},${abs % 10} %`;
}

const MAX_TEXT_IN_BRIEF = 40;

/** Untrusted Lexware text for the brief: delimiters replaced, whitespace collapsed, shortened, in «». */
export function quoteUntrusted(value: string | null): string {
  if (value === null) return "–";
  // Defense in depth (PR 1 already sanitizes): no control, format, line or paragraph separator characters.
  const cleaned = value.replace(/[«»]/g, '"').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  const chars = Array.from(cleaned);
  const short = chars.length > MAX_TEXT_IN_BRIEF ? `${chars.slice(0, MAX_TEXT_IN_BRIEF - 1).join("")}…` : cleaned;
  return `«${short}»`;
}

function day(dayValue: string | null): string {
  return dayValue === null ? "ohne Datum" : formatDayDe(dayValue);
}

function rangeText(range: DayRange): string {
  return `${formatDayDe(range.from)}–${formatDayDe(range.to)}`;
}

function sumText(sums: ReadonlyArray<CurrencySum>): string {
  if (sums.length === 0) return formatMoney(0);
  return currencyLimited(sums, (s) => formatMoney(s.cents, s.currency), " und ");
}

function statusTotalText(t: StatusTotal): string {
  // An unknown amount is never shown as 0,00 €: without any usable amount there is no sum to show.
  if (t.openByCurrency.length === 0) return t.itemsWithoutUsableAmount > 0 ? "Betrag nicht belastbar" : formatMoney(0);
  const sums = currencyLimited(t.openByCurrency, (s) => formatMoney(s.cents, s.currency), " und ");
  return t.itemsWithoutUsableAmount > 0 ? `${sums} belastbar, zusätzlich ohne belastbaren Betrag: ${t.itemsWithoutUsableAmount}` : sums;
}

function mergeTotals(a: StatusTotal, b: StatusTotal): StatusTotal {
  const map = new Map<string, { cents: number | null; items: number }>();
  for (const s of [...a.openByCurrency, ...b.openByCurrency]) {
    const e = map.get(s.currency) ?? { cents: 0, items: 0 };
    map.set(s.currency, { cents: e.cents === null || s.cents === null ? null : addCents(e.cents, s.cents), items: e.items + s.items });
  }
  return {
    items: a.items + b.items,
    itemsWithoutUsableAmount: a.itemsWithoutUsableAmount + b.itemsWithoutUsableAmount,
    openByCurrency: [...map.entries()].sort(([x], [y]) => compareCodeUnits(x, y)).map(([currency, v]) => ({ currency, ...v })),
  };
}

const GRADE_TEXT: Readonly<Record<DataQualityGrade, string>> = {
  GOOD: "GUT (GOOD)",
  LIMITED: "EINGESCHRÄNKT (LIMITED)",
  POOR: "SCHLECHT (POOR)",
  NO_DATA: "KEINE DATEN (NO_DATA)",
};

const FINDING_TEXT: Readonly<Record<DataQualityFindingCode, string>> = {
  LIST_INCOMPLETE: "Belegliste nicht vollständig geladen",
  ROWS_REJECTED: "Verworfene Zeilen der Belegliste (ungültige ID oder Form; in keiner Summe enthalten)",
  CRITICAL_RECORDS: "Geprüfte Belege mit kritischem Datenbefund (nicht in Summen)",
  SOURCE_CONFLICT: "Belege mit widersprüchlichen Quellen",
  STATUS_UNKNOWN: "Belege mit unbekanntem oder widersprüchlichem Status",
  FETCH_FAILED: "Fehlgeschlagene Detailabrufe",
  UNREVIEWED: "Ungeprüfte Belege (Belegeingang, nicht in Summen)",
  COUNTERPARTY_MISSING: "Belege ohne identifizierte Gegenpartei",
  DUE_DATE_UNRELIABLE: "Offene Posten ohne belastbare Fälligkeit",
  AMOUNT_MISSING: "Belege ohne belastbaren Betrag",
  VOUCHER_DATE_MISSING: "Belege ohne belastbares Belegdatum",
  DIRECTION_UNCLEAR: "Belege mit unklarer Richtung (Gutschrift oder unbekannter Typ)",
  PAYMENT_INFO_MISSING: "Belege ohne Zahlungsinformation in Lexware",
};

const NOT_EVALUATED_TEXT: Readonly<Record<NotEvaluated["reason"], string>> = {
  DATA_INCOMPLETE: "Belegliste unvollständig",
  BASE_ZERO: "Vergleichsbasis 0, relative Änderung nicht definiert",
  NOT_COMPUTABLE: "Wert nicht berechenbar",
  UNREVIEWED_SHARE_TOO_HIGH: "zu viele ungeprüfte Belege in einem der Zeiträume",
  EXCLUDED_DOCUMENTS: "geprüfte Belege ohne belastbaren Betrag oder mit kritischem Datenbefund im Vergleich",
  UNASSIGNED_DOCUMENTS: "geprüfte Belege ohne belastbares Belegdatum, keinem Zeitraum zuordenbar",
};

/** Currencies listed per figure in the text; the rest is counted (the structured result keeps all). */
const MAX_CURRENCIES_IN_TEXT = 3;

function currencyLimited<T>(items: ReadonlyArray<T>, render: (item: T) => string, joiner: string): string {
  const shown = items.slice(0, MAX_CURRENCIES_IN_TEXT).map(render).join(joiner);
  const more = items.length - MAX_CURRENCIES_IN_TEXT;
  return more > 0 ? `${shown}${joiner}${more} weitere Währungen` : shown;
}

/** Lexware ids are validated upstream; anything else is never printed (it could carry forged text). */
function safeId(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id) ? id : "(ungültige ID)";
}

/** Anomaly checks that did not run for a reason other than a zero base (where the rule cannot fire by definition). */
function skippedAnomalyChecks(p: PeriodComparison): string[] {
  const names = new Set<string>();
  for (const n of p.notEvaluated) {
    if (n.reason === "BASE_ZERO") continue;
    names.add(n.subject.type === "METRIC" ? (n.subject.metric === "reliableExpenses" ? "Ausgaben" : "Lexware-Rechnungserlöse") : "Lieferanten");
  }
  return [...names];
}

const CONTRADICTION_REASONS: ReadonlySet<OpenItemReason> = new Set<OpenItemReason>([
  "OPEN_AMOUNT_ZERO_WHILE_OPEN",
  "OPEN_AMOUNT_POSITIVE_WHILE_PAID",
  "OPEN_AMOUNT_NEGATIVE",
  "OPEN_AMOUNT_EXCEEDS_GROSS",
  "OPEN_AMOUNT_CONFLICT",
  "STATUS_CONFLICT",
]);

function directionText(item: OpenItem): string {
  return item.direction === "RECEIVABLE" ? "Forderung" : item.direction === "PAYABLE" ? "Verbindlichkeit" : "Richtung unklar";
}

function openItemRef(item: OpenItem): string {
  const amount =
    isUsable(item.openCents) && item.currency !== null ? formatMoney(item.openCents.value, item.currency) : "offener Betrag nicht belastbar";
  return `${directionText(item)} ${quoteUntrusted(item.voucherNumber)} vom ${day(item.voucherDate)}, ${quoteUntrusted(item.counterpartyName)}, ${amount}`;
}

function recordRef(record: FinanceRecord | undefined, id: string): string {
  if (!record) return `Beleg ${safeId(id)}`;
  const gross = grossAmount(record);
  const number = isUsable(record.voucherNumber) ? record.voucherNumber.value : null;
  const date = isUsable(record.voucherDate) ? record.voucherDate.value : null;
  const name = isUsable(record.counterparty.name) ? record.counterparty.name.value : null;
  const amount = gross ? formatMoney(gross.cents, gross.currency) : "Betrag unbekannt";
  const unreviewed = record.statusCategory === "UNCHECKED" ? ", ungeprüft" : "";
  return `${quoteUntrusted(number)} vom ${day(date)}, ${quoteUntrusted(name)}, ${amount}${unreviewed} (ID ${safeId(record.id)})`;
}

function ruleTextDe(rule: DuplicateRuleId, windowDays: number): string {
  switch (rule) {
    case "E1":
      return "gleicher Datei-Hash";
    case "E2":
      return "gleiche Gegenpartei, Belegnummer, Betrag und Belegtag";
    case "P1":
      return "gleiche Gegenpartei, Belegnummer und Betrag";
    case "S2":
      return "gleiche Gegenpartei und Belegnummer, Betrag abweichend oder unbekannt";
    case "S3":
      return `gleiche Belegnummer und Betrag binnen ${windowDays} Tagen, Gegenpartei abweichend oder unbekannt`;
    case "S1":
      return `gleiche Gegenpartei und Betrag binnen ${windowDays} Tagen, Belegnummern nicht verschieden`;
  }
}

const CLASS_TEXT: Readonly<Record<PairResult["classification"], string>> = {
  EXACT_DUPLICATE: "Exakte Dublette",
  PROBABLE_DUPLICATE: "Wahrscheinliche Dublette",
  POSSIBLE_DUPLICATE: "Mögliche Dublette",
  NOT_DUPLICATE: "Keine Dublette",
};

function moneyRow(rows: ReadonlyArray<MoneyComparison>, metric: MoneyComparison["metric"], label: string): string[] {
  const out: string[] = [];
  const matching = rows.filter((r) => r.metric === metric);
  for (const row of matching.slice(0, MAX_CURRENCIES_IN_TEXT)) {
    const rel = row.relative.ok ? formatPercentTenths(row.relative.tenthsOfPercent) : row.relative.reason === "BASE_ZERO" ? "relativ nicht definiert (Basis 0)" : "relativ nicht berechenbar";
    out.push(
      `- ${label}: ${formatMoney(row.current, row.currency)} vs. ${formatMoney(row.comparison, row.currency)} · ` +
        `Δ ${formatMoneyDelta(row.absoluteDiff, row.currency)} · ${rel}`,
    );
  }
  if (matching.length > MAX_CURRENCIES_IN_TEXT) out.push(`- ${label}: ${matching.length - MAX_CURRENCIES_IN_TEXT} weitere Währungen (siehe strukturiertes Ergebnis)`);
  if (out.length === 0) out.push(`- ${label}: ${formatMoney(0)} vs. ${formatMoney(0)} · Δ ${formatMoneyDelta(0)} · relativ nicht definiert (Basis 0)`);
  return out;
}

function anomalyText(a: Anomaly): string {
  const subject =
    a.subject.type === "METRIC"
      ? a.subject.metric === "reliableExpenses"
        ? "Belastbare Ausgaben (brutto)"
        : "Lexware-Rechnungserlöse (brutto)"
      : a.subject.type === "SUPPLIER"
        ? `Lieferant ${quoteUntrusted(a.subject.name)}`
        : "Lieferanten";
  return (
    `${subject}: ${formatMoney(a.current, a.currency)} vs. ${formatMoney(a.comparison, a.currency)} ` +
    `(Δ ${formatMoneyDelta(a.absoluteDiff, a.currency)}, ${formatPercentTenths(a.relativeTenthsOfPercent)})`
  );
}

function notEvaluatedText(n: NotEvaluated): string {
  const subject =
    n.subject.type === "METRIC"
      ? n.subject.metric === "reliableExpenses"
        ? "Ausgaben"
        : "Lexware-Rechnungserlöse"
      : n.subject.type === "SUPPLIERS"
        ? n.count !== undefined
          ? `${n.count} Lieferanten`
          : "Lieferanten"
        : `Lieferant ${quoteUntrusted(n.subject.name)}`;
  return `${subject}: nicht bewertet (${NOT_EVALUATED_TEXT[n.reason]})`;
}

function listWithLimit(lines: string[], limit: number): string[] {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `… und ${lines.length - limit} weitere`];
}

function itemsWithLimit(items: AttentionItem[], limit: number, moreReason: BriefReason): AttentionItem[] {
  if (items.length <= limit) return items;
  return [...items.slice(0, limit), { reason: moreReason, text: `… und ${items.length - limit} weitere` }];
}

// ---------------------------------------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------------------------------------

export function buildDailyBrief(input: BriefInput): DailyBrief {
  const limit = input.maxListItems ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("maxListItems must be an integer between 1 and 100");
  // Same deterministic copy per id as the analyses use, so repeated ids cannot change the text.
  const byId = new Map(uniqueById(input.records).records.map((r) => [r.id, r] as const));
  const reasons = new Set<BriefReason>();
  const attention: AttentionItem[] = [];
  const info: string[] = [];
  const dq = input.dataQuality;
  const items = input.openItems.items;
  const p = input.periods;

  // Load.
  if (input.load.list !== "COMPLETE") {
    reasons.add("LIST_INCOMPLETE");
    attention.push({
      reason: "LIST_INCOMPLETE",
      text:
        `Belegliste ${input.load.list === "FAILED" ? "nicht geladen" : "nur teilweise geladen"} (Grund: ${input.load.listReason}). ` +
        "Alle Summen sind Untergrenzen; Auffälligkeiten werden nicht bewertet.",
    });
  }

  // Data quality. An empty but complete load is not "all clear": it more likely means a wrong organisation,
  // missing permissions or a misconfiguration than a month without documents.
  if (dq.grade === "NO_DATA" && input.load.list === "COMPLETE") {
    reasons.add("NO_DATA");
    attention.push({ reason: "NO_DATA", text: `Keine finanzrelevanten Belege im Ladefenster ${rangeText(input.load.window)}: Lexware-Zugang und Organisation prüfen.` });
  }
  if (dq.grade === "POOR") reasons.add("DATA_QUALITY_POOR");
  if (dq.grade === "LIMITED") reasons.add("DATA_QUALITY_LIMITED");
  if (dq.grade === "POOR" || dq.grade === "LIMITED") {
    for (const code of dq.triggeredBy) {
      if (code === "LIST_INCOMPLETE") continue;
      const f = dq.findings.find((x) => x.code === code);
      if (!f) continue;
      const share = f.of !== null ? ` von ${f.of}` : "";
      attention.push({ reason: dq.grade === "POOR" ? "DATA_QUALITY_POOR" : "DATA_QUALITY_LIMITED", text: `Datenqualität – ${FINDING_TEXT[code]}: ${f.count}${share}.` });
    }
  }

  // Duplicates.
  const dup = input.duplicates;
  const exactReviewed = dup.findings.filter((f) => f.classification === "EXACT_DUPLICATE" && !f.evidence.unreviewedInvolved);
  if (exactReviewed.length > 0) reasons.add("EXACT_DUPLICATE_REVIEWED");
  const candidates = dup.findings.filter((f) => !(f.classification === "EXACT_DUPLICATE" && !f.evidence.unreviewedInvolved));
  if (candidates.length > 0) reasons.add("DUPLICATE_CANDIDATES");
  const dupItems: AttentionItem[] = [...exactReviewed, ...candidates].map((f) => ({
    reason: f.classification === "EXACT_DUPLICATE" && !f.evidence.unreviewedInvolved ? "EXACT_DUPLICATE_REVIEWED" : "DUPLICATE_CANDIDATES",
    text:
      `${CLASS_TEXT[f.classification]} (Regel ${f.rule}: ${f.rule ? ruleTextDe(f.rule, dup.config.windowDays) : ""}): ` +
      `${recordRef(byId.get(f.recordIds[0]), f.recordIds[0])} | ${recordRef(byId.get(f.recordIds[1]), f.recordIds[1])}`,
  }));
  attention.push(...itemsWithLimit(dupItems, limit, "DUPLICATE_CANDIDATES"));
  if (!dup.complete) {
    reasons.add("DUPLICATE_ANALYSIS_INCOMPLETE");
    attention.push({ reason: "DUPLICATE_ANALYSIS_INCOMPLETE", text: "Dublettenprüfung unvollständig (Paarlimit erreicht); Ergebnis ist eine Untergrenze." });
  }

  // Open items.
  const overdue = items.filter((i) => i.status === "OVERDUE_CONFIRMED");
  const possibly = items.filter((i) => i.status === "POSSIBLY_OVERDUE");
  const unreliable = items.filter((i) => i.status === "DUE_DATE_UNRELIABLE");
  const contradictions = items.filter((i) => i.reasons.some((r) => CONTRADICTION_REASONS.has(r)));
  const t = input.openItems.totals;
  if (overdue.length > 0) {
    reasons.add("OVERDUE_CONFIRMED");
    for (const dir of ["RECEIVABLE", "PAYABLE"] as const) {
      const total = t[dir].OVERDUE_CONFIRMED;
      if (total.items === 0) continue;
      attention.push({
        reason: "OVERDUE_CONFIRMED",
        text: `Belastbar überfällig (Fälligkeit mit Zahlungsziel oder eigenem Fälligkeitsdatum überschritten) – ${dir === "RECEIVABLE" ? "Forderungen" : "Verbindlichkeiten"}: ${total.items}, ${statusTotalText(total)}.`,
      });
    }
    const oldest = [...overdue].sort((a, b) => (b.daysPastDue ?? 0) - (a.daysPastDue ?? 0) || compareCodeUnits(a.recordId, b.recordId));
    for (const line of listWithLimit(oldest.map((i) => `${openItemRef(i)}, ${i.daysPastDue} Tage über Fälligkeit`), limit)) {
      attention.push({ reason: "OVERDUE_CONFIRMED", text: line });
    }
  }
  if (possibly.length > 0) {
    reasons.add("POSSIBLY_OVERDUE");
    for (const dir of ["RECEIVABLE", "PAYABLE"] as const) {
      const total = t[dir].POSSIBLY_OVERDUE;
      if (total.items === 0) continue;
      attention.push({
        reason: "POSSIBLY_OVERDUE",
        text:
          `Möglicherweise überfällig (Fälligkeit nicht belastbar, z. B. gleich Belegdatum ohne Zahlungsziel) – ` +
          `${dir === "RECEIVABLE" ? "Forderungen" : "Verbindlichkeiten"}: ${total.items}, ${statusTotalText(total)}.`,
      });
    }
    if (t.UNKNOWN.POSSIBLY_OVERDUE.items > 0) {
      attention.push({ reason: "POSSIBLY_OVERDUE", text: `Möglicherweise überfällig mit unklarer Richtung – Belege: ${t.UNKNOWN.POSSIBLY_OVERDUE.items}.` });
    }
  }
  if (unreliable.length > 0) {
    reasons.add("DUE_DATE_UNRELIABLE");
    attention.push({ reason: "DUE_DATE_UNRELIABLE", text: `Offen laut Lexware, Fälligkeit nicht belastbar und nicht überschritten – Posten: ${unreliable.length}.` });
  }
  if (contradictions.length > 0) {
    reasons.add("STATUS_CONTRADICTION");
    attention.push({ reason: "STATUS_CONTRADICTION", text: `Widerspruch zwischen Lexware-Status und offenem Betrag oder zwischen Quellen – Belege: ${contradictions.length}.` });
    for (const line of listWithLimit(contradictions.map((i) => `${openItemRef(i)} (${i.reasons.filter((r) => CONTRADICTION_REASONS.has(r)).join(", ")})`), limit)) {
      attention.push({ reason: "STATUS_CONTRADICTION", text: line });
    }
  }

  // Anomalies.
  if (p.anomalies.length > 0) {
    reasons.add("ANOMALY");
    for (const line of listWithLimit(p.anomalies.map(anomalyText), limit)) attention.push({ reason: "ANOMALY", text: `Auffälligkeit: ${line}` });
  }

  // Unreviewed documents.
  if (dq.scope.unreviewedRecords > 0) {
    reasons.add("UNREVIEWED_DOCUMENTS");
    attention.push({
      reason: "UNREVIEWED_DOCUMENTS",
      text: `Ungeprüfte Belege im Ladefenster ${rangeText(input.load.window)} (Lexware-Belegeingang): ${dq.scope.unreviewedRecords}, nicht in den Summen enthalten.`,
    });
  }

  // Informational.
  if (dup.complete && dup.counts.EXACT_DUPLICATE + dup.counts.PROBABLE_DUPLICATE + dup.counts.POSSIBLE_DUPLICATE === 0) {
    info.push(`Dublettenprüfung (verglichene Belege: ${dup.recordsConsidered}): keine Dubletten-Kandidaten.`);
  } else if (dup.complete && exactReviewed.length === 0) {
    info.push(`Dublettenprüfung (verglichene Belege: ${dup.recordsConsidered}): keine exakte Dublette zwischen zwei geprüften Belegen.`);
  }
  const skipped = skippedAnomalyChecks(p);
  if (p.dataComplete && p.anomalies.length === 0) {
    // "No anomaly" is only claimed for checks that ran.
    const scope = skipped.length === 0 ? "keine Auffälligkeit." : `keine Auffälligkeit unter den bewerteten Kennzahlen; nicht bewertet: ${skipped.join(", ")}.`;
    info.push(`Auffälligkeitsregel (≥ ${formatPercentNumber(p.rule.minRelativeChangePercent)} % und ≥ ${formatMoney(p.rule.minAbsoluteChangeCents, p.rule.currency)}): ${scope}`);
  }
  for (const n of p.notEvaluated) info.push(notEvaluatedText(n));
  const openConfirmed = mergeTotals(t.RECEIVABLE.OPEN_CONFIRMED, t.PAYABLE.OPEN_CONFIRMED);
  if (openConfirmed.items > 0) info.push(`Offen laut Lexware, belastbar noch nicht fällig – Posten: ${openConfirmed.items}, ${statusTotalText(openConfirmed)}.`);
  const paid = input.openItems.counts.PAID_CONFIRMED;
  if (paid > 0) info.push(`Laut Lexware-Status bezahlt (offener Betrag 0) – Belege im Ladefenster: ${paid}.`);
  const meaningUnverified = items.filter((i) => i.reasons.includes("STATUS_MEANING_UNVERIFIED")).length;
  if (meaningUnverified > 0) info.push(`Lexware-Status mit nicht verifizierter Bedeutung (z. B. Lastschrift) – Belege: ${meaningUnverified}, nicht als offen oder bezahlt gewertet.`);
  const cur = p.current;
  if (cur.notNetted.purchaseCreditNotes + cur.notNetted.salesCreditNotes > 0) {
    info.push(`Gutschriften im laufenden Monat (Vorzeichen nicht verifiziert, nicht verrechnet): ${cur.notNetted.purchaseCreditNotes + cur.notNetted.salesCreditNotes}.`);
  }
  if (cur.notNetted.downPaymentInvoices > 0) {
    info.push(`Abschlagsrechnungen im laufenden Monat (nicht in den Erlösen, Doppelzählungsrisiko): ${cur.notNetted.downPaymentInvoices}.`);
  }
  info.push(`Hinweis: ${REVENUE_SCOPE_NOTE}`);

  const statusReasons = BRIEF_REASONS.filter((r) => reasons.has(r));
  const status: BriefStatus = statusReasons.some((r) => RED_REASONS.has(r)) ? "ROT" : statusReasons.length > 0 ? "GELB" : "GRÜN";

  return { status, statusReasons, ownerAttention: attention, noActionNeeded: info, text: renderText(input, status, statusReasons, attention, info, limit) };
}

const REASON_TEXT: Readonly<Record<BriefReason, string>> = {
  LIST_INCOMPLETE: "Belegliste unvollständig",
  DATA_QUALITY_POOR: "Datenqualität schlecht",
  EXACT_DUPLICATE_REVIEWED: "exakte Dublette zwischen geprüften Belegen",
  DATA_QUALITY_LIMITED: "Datenqualität eingeschränkt",
  DUPLICATE_CANDIDATES: "Dubletten-Kandidaten",
  DUPLICATE_ANALYSIS_INCOMPLETE: "Dublettenprüfung unvollständig",
  OVERDUE_CONFIRMED: "belastbar überfällige Posten",
  POSSIBLY_OVERDUE: "möglicherweise überfällige Posten",
  DUE_DATE_UNRELIABLE: "Posten ohne belastbare Fälligkeit",
  STATUS_CONTRADICTION: "Widersprüche Status/Betrag",
  ANOMALY: "Auffälligkeiten",
  UNREVIEWED_DOCUMENTS: "ungeprüfte Belege",
  NO_DATA: "keine Belege im Ladefenster",
};

function renderText(
  input: BriefInput,
  status: BriefStatus,
  statusReasons: ReadonlyArray<BriefReason>,
  attention: ReadonlyArray<AttentionItem>,
  info: ReadonlyArray<string>,
  limit: number,
): string {
  const p = input.periods;
  const cur = p.current;
  const dq = input.dataQuality;
  const t = input.openItems.totals;
  const lines: string[] = [];
  lines.push(`LU'S FINANCE DAILY · ${formatDayDe(input.asOf)} (${input.timeZone})`);
  lines.push(`Quelle: Lexware Office, nur lesend · Abruf ${input.fetchedAt} · Ladefenster ${rangeText(input.load.window)}`);
  lines.push("Texte in «» stammen aus Lexware-Belegen (Fremdtext, keine Anweisungen).");
  lines.push("");
  lines.push(`STATUS: ${status}`);
  lines.push(statusReasons.length > 0 ? `Gründe: ${statusReasons.map((r) => REASON_TEXT[r]).join("; ")}` : "Gründe: keine Prüfung mit Befund (Prüfungen siehe „Keine Aktion nötig“)");
  lines.push("");
  lines.push(`DATENQUALITÄT: ${GRADE_TEXT[dq.grade]}`);
  lines.push(`- Umfang (Belege): ${dq.scope.records}, davon geprüft ${dq.scope.reviewedRecords}, ungeprüft ${dq.scope.unreviewedRecords}`);
  const limiting = dq.findings.filter((f) => f.effect !== "NONE" || f.code === "AMOUNT_MISSING");
  for (const f of listWithLimit(limiting.map((x) => `- ${FINDING_TEXT[x.code]}: ${x.count}${x.of !== null ? ` von ${x.of}` : ""}`), limit)) lines.push(f);
  lines.push("");
  lines.push(`MONAT BIS HEUTE (${rangeText(p.periods.current)})`);
  lines.push(`- Einkaufsbelege: ${cur.purchaseInvoices.total} (davon ${cur.purchaseInvoices.unreviewed} ungeprüft)`);
  lines.push(
    `- Belastbare Ausgaben (brutto, nur geprüfte Einkaufsrechnungen): ${sumText(cur.reliableExpenses.byCurrency)} (Belege: ${cur.reliableExpenses.includedRecords})` +
      exclusionsText(cur.reliableExpenses.excluded),
  );
  lines.push(
    `- Lexware-Rechnungserlöse (brutto): ${sumText(cur.lexwareInvoiceRevenue.byCurrency)} (Belege: ${cur.lexwareInvoiceRevenue.includedRecords})` +
      exclusionsText(cur.lexwareInvoiceRevenue.excluded),
  );
  const openReceivable = mergeTotals(
    mergeTotals(mergeTotals(t.RECEIVABLE.OVERDUE_CONFIRMED, t.RECEIVABLE.POSSIBLY_OVERDUE), t.RECEIVABLE.DUE_DATE_UNRELIABLE),
    t.RECEIVABLE.OPEN_CONFIRMED,
  );
  const openPayable = mergeTotals(
    mergeTotals(mergeTotals(t.PAYABLE.OVERDUE_CONFIRMED, t.PAYABLE.POSSIBLY_OVERDUE), t.PAYABLE.DUE_DATE_UNRELIABLE),
    t.PAYABLE.OPEN_CONFIRMED,
  );
  lines.push(`- Offene Forderungen laut Lexware (Stand Abruf, Ladefenster): ${statusTotalText(openReceivable)} (Posten: ${openReceivable.items})`);
  lines.push(`- Offene Verbindlichkeiten laut Lexware (Stand Abruf, Ladefenster): ${statusTotalText(openPayable)} (Posten: ${openPayable.items})`);
  lines.push(`- Ungeprüfte Belege: ${cur.unreviewed}`);
  lines.push(`- Hinweis: ${REVENUE_SCOPE_NOTE}`);
  lines.push("");
  lines.push(`VERGLEICH MTD vs. VORMONAT GLEICHER ZEITRAUM (${rangeText(p.periods.previousSamePeriod)})`);
  const same = p.vsPreviousSamePeriod;
  lines.push(...moneyRow(same.money, "reliableExpenses", "Belastbare Ausgaben"));
  lines.push(...moneyRow(same.money, "lexwareInvoiceRevenue", "Lexware-Rechnungserlöse"));
  for (const c of same.counts.filter((x) => x.metric === "purchaseInvoices")) {
    const rel = c.relative.ok ? formatPercentTenths(c.relative.tenthsOfPercent) : "relativ nicht definiert (Basis 0)";
    lines.push(`- Einkaufsbelege (Anzahl): ${c.current} vs. ${c.comparison} · Δ ${c.absoluteDiff >= 0 ? "+" : ""}${c.absoluteDiff} · ${rel}`);
  }
  const full = p.previousFull;
  lines.push(
    `Vormonat gesamt (${rangeText(p.periods.previousFull)}): belastbare Ausgaben ${sumText(full.reliableExpenses.byCurrency)}, ` +
      `Lexware-Rechnungserlöse ${sumText(full.lexwareInvoiceRevenue.byCurrency)}, Einkaufsbelege ${full.purchaseInvoices.total}`,
  );
  if (!p.dataComplete) lines.push("Achtung: Belegliste unvollständig, alle Werte sind Untergrenzen.");
  lines.push("");
  const d = input.duplicates;
  lines.push("DUBLETTEN");
  lines.push(`- exakt: ${d.counts.EXACT_DUPLICATE} · wahrscheinlich: ${d.counts.PROBABLE_DUPLICATE} · möglich: ${d.counts.POSSIBLE_DUPLICATE}`);
  lines.push(
    `- verglichene Belege: ${d.recordsConsidered}, Paare: ${d.pairsEvaluated}, Belege mit Datei-Hash: ${d.recordsWithFileHash}` +
      (d.complete ? "" : " · UNVOLLSTÄNDIG (Paarlimit)"),
  );
  lines.push("");
  lines.push(`AUFFÄLLIGKEITEN (Regel: ≥ ${formatPercentNumber(p.rule.minRelativeChangePercent)} % und ≥ ${formatMoney(p.rule.minAbsoluteChangeCents, p.rule.currency)}, MTD vs. Vormonat gleicher Zeitraum)`);
  const skippedChecks = skippedAnomalyChecks(p);
  if (p.anomalies.length === 0) {
    if (!p.dataComplete) lines.push("- nicht bewertet (Belegliste unvollständig)");
    else lines.push(skippedChecks.length === 0 ? "- keine" : `- keine unter den bewerteten Kennzahlen (nicht bewertet: ${skippedChecks.join(", ")})`);
  } else if (skippedChecks.length > 0) {
    lines.push(`- nicht bewertet: ${skippedChecks.join(", ")}`);
  }
  for (const a of listWithLimit(p.anomalies.map(anomalyText), limit)) lines.push(`- ${a}`);
  lines.push("");
  lines.push("OWNER ATTENTION");
  if (attention.length === 0) lines.push("- keine");
  for (const a of attention) lines.push(`- ${a.text}`);
  lines.push("");
  lines.push("KEINE AKTION NÖTIG");
  for (const i of info) lines.push(`- ${i}`);
  return `${lines.join("\n")}\n`;
}

function exclusionsText(excluded: Readonly<Record<string, number>>): string {
  const labels: Readonly<Record<string, string>> = {
    UNREVIEWED: "ungeprüft",
    STATUS_UNKNOWN: "Status unklar",
    CRITICAL_ISSUE: "kritischer Datenbefund",
    AMOUNT_NOT_USABLE: "ohne belastbaren Betrag",
  };
  const parts = Object.entries(labels)
    .filter(([key]) => (excluded[key] ?? 0) > 0)
    .map(([key, label]) => `${excluded[key]} ${label}`);
  return parts.length > 0 ? `; nicht enthalten: ${parts.join(", ")}` : "";
}
