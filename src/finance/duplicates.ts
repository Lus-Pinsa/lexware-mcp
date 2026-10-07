/**
 * Deterministic, explainable duplicate detection over canonical finance records.
 *
 * - Pure: no I/O, no clock. The engine never changes, marks or deletes a document; it only reports pairs.
 * - Every result names the rule that fired (the reproducible "confidence") and the evidence per dimension.
 * - Only usable (STRUCTURED/DERIVED) values are compared. MISSING, PLACEHOLDER, CONFLICT and UNVERIFIED values are
 *   "not comparable" and never count as a match.
 * - A shared attachment hash (E1: the same file) is conclusive on its own; every other rule needs at least two
 *   independent signals, one of them the voucher number or the counterparty. An equal amount alone (even on the same
 *   day) never makes a duplicate.
 */
import { daysBetween } from "./calendar.js";
import { compareCodeUnits, grossAmount, uniqueById, voucherDay } from "./facts.js";
import type { DocumentRole, FinanceKind, FinanceRecord } from "./model.js";
import { normalizeNameKey } from "./normalize.js";
import { isUsable } from "./values.js";

export const DUPLICATE_CLASSES = ["EXACT_DUPLICATE", "PROBABLE_DUPLICATE", "POSSIBLE_DUPLICATE", "NOT_DUPLICATE"] as const;
export type DuplicateClass = (typeof DUPLICATE_CLASSES)[number];

export const DUPLICATE_RULE_IDS = ["E1", "E2", "P1", "S2", "S3", "S1"] as const;
export type DuplicateRuleId = (typeof DUPLICATE_RULE_IDS)[number];

/** The rule table, in evaluation order (first match wins). */
export const DUPLICATE_RULES: Readonly<Record<DuplicateRuleId, { readonly classification: DuplicateClass; readonly rule: string }>> = {
  E1: { classification: "EXACT_DUPLICATE", rule: "shared attachment SHA-256" },
  E2: { classification: "EXACT_DUPLICATE", rule: "same counterparty + same voucher number + same amount + same voucher day" },
  P1: { classification: "PROBABLE_DUPLICATE", rule: "same counterparty + same voucher number + same amount" },
  S2: { classification: "POSSIBLE_DUPLICATE", rule: "same counterparty + same voucher number, amount different or unknown" },
  S3: { classification: "POSSIBLE_DUPLICATE", rule: "same voucher number + same amount within the day window, counterparty different or unknown" },
  S1: { classification: "POSSIBLE_DUPLICATE", rule: "same counterparty + same amount within the day window, voucher numbers not different" },
};

export const DUPLICATE_REASON_CODES = [
  "SAME_FILE_HASH",
  "FILE_HASH_DIFFERS",
  "FILE_HASH_NOT_COMPARABLE",
  "SAME_CONTACT_ID",
  "SAME_COUNTERPARTY_NAME",
  "COUNTERPARTY_DIFFERS",
  "COUNTERPARTY_NOT_COMPARABLE",
  "SAME_VOUCHER_NUMBER",
  "VOUCHER_NUMBER_DIFFERS",
  "VOUCHER_NUMBER_NOT_COMPARABLE",
  "SAME_AMOUNT",
  "AMOUNT_DIFFERS",
  "AMOUNT_NOT_COMPARABLE",
  "SAME_VOUCHER_DAY",
  "WITHIN_DAY_WINDOW",
  "OUTSIDE_DAY_WINDOW",
  "VOUCHER_DAY_NOT_COMPARABLE",
  "UNREVIEWED_INVOLVED",
] as const;
export type DuplicateReasonCode = (typeof DUPLICATE_REASON_CODES)[number];

export interface DuplicateConfig {
  /** Day window for the weaker rules (S1, S3). */
  readonly windowDays: number;
  /** Safety cap on evaluated candidate pairs; exceeding it makes the analysis incomplete (never silently). */
  readonly maxPairs: number;
}

export const DEFAULT_DUPLICATE_CONFIG: DuplicateConfig = Object.freeze({ windowDays: 14, maxPairs: 50_000 });

export function resolveDuplicateConfig(config: Partial<DuplicateConfig> = {}): DuplicateConfig {
  const windowDays = config.windowDays ?? DEFAULT_DUPLICATE_CONFIG.windowDays;
  const maxPairs = config.maxPairs ?? DEFAULT_DUPLICATE_CONFIG.maxPairs;
  if (!Number.isSafeInteger(windowDays) || windowDays < 0 || windowDays > 366) {
    throw new RangeError("windowDays must be an integer between 0 and 366");
  }
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 1 || maxPairs > 1_000_000) {
    throw new RangeError("maxPairs must be an integer between 1 and 1000000");
  }
  return { windowDays, maxPairs };
}

export type CounterpartyEvidence = "SAME_CONTACT_ID" | "SAME_NAME" | "DIFFERENT" | "NOT_COMPARABLE";
export type MatchEvidence = "SAME" | "DIFFERENT" | "NOT_COMPARABLE";
export type DayEvidence = "SAME_DAY" | "WITHIN_WINDOW" | "OUTSIDE_WINDOW" | "NOT_COMPARABLE";

export interface PairEvidence {
  readonly fileHash: MatchEvidence;
  readonly counterparty: CounterpartyEvidence;
  readonly voucherNumber: MatchEvidence;
  readonly amount: MatchEvidence;
  readonly voucherDay: DayEvidence;
  /** Absolute day distance when both voucher days are usable. */
  readonly dayDistance: number | null;
  readonly unreviewedInvolved: boolean;
}

export interface PairResult {
  readonly classification: DuplicateClass;
  /** The rule that fired; null for NOT_DUPLICATE. */
  readonly rule: DuplicateRuleId | null;
  /** The two Lexware ids, in code-unit order. */
  readonly recordIds: readonly [string, string];
  readonly reasonCodes: ReadonlyArray<DuplicateReasonCode>;
  readonly evidence: PairEvidence;
}

/** Normalized voucher number usable as a business key, or null when it is not distinctive enough. */
export function normalizeVoucherNumberKey(raw: string): string | null {
  const key = raw.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "");
  // At least 3 characters and a non-zero digit: "Rechnung", "-" or "0" identify nothing.
  return key.length >= 3 && /[1-9]/.test(key) ? key : null;
}

const SHA256 = /^[0-9a-f]{64}$/;

interface Facts {
  readonly record: FinanceRecord;
  readonly numberKey: string | null;
  readonly amount: { cents: number; currency: string } | null;
  readonly day: string | null;
  readonly hashes: ReadonlySet<string>;
  readonly unreviewed: boolean;
}

function factsOf(record: FinanceRecord): Facts {
  const numberKey = isUsable(record.voucherNumber) ? normalizeVoucherNumberKey(record.voucherNumber.value) : null;
  const gross = grossAmount(record);
  const hashes = new Set<string>();
  // Only usable attachment lists, and only non-empty files: every empty file has the same SHA-256.
  for (const a of isUsable(record.attachments) ? record.attachments.value : []) {
    const sha = a.inspection?.sha256;
    const bytes = a.inspection?.byteLength;
    if (typeof sha === "string" && SHA256.test(sha) && typeof bytes === "number" && bytes > 0) hashes.add(sha);
  }
  return {
    record,
    numberKey,
    // A zero amount is no evidence (it is often a placeholder).
    amount: gross !== null && gross.cents !== 0 ? gross : null,
    day: voucherDay(record),
    hashes,
    unreviewed: record.statusCategory === "UNCHECKED",
  };
}

function nameKeyOf(record: FinanceRecord): string {
  return isUsable(record.counterparty.name) ? normalizeNameKey(record.counterparty.name.value) : "";
}

function compareCounterparty(a: FinanceRecord, b: FinanceRecord): CounterpartyEvidence {
  const ca = a.counterparty;
  const cb = b.counterparty;
  if (ca.matchKeyBasis === "NONE" || cb.matchKeyBasis === "NONE" || ca.matchKey === null || cb.matchKey === null) {
    return "NOT_COMPARABLE";
  }
  if (ca.matchKeyBasis === "CONTACT_ID" && cb.matchKeyBasis === "CONTACT_ID") {
    return ca.matchKey === cb.matchKey ? "SAME_CONTACT_ID" : "DIFFERENT";
  }
  if (ca.matchKeyBasis === "NAME" && cb.matchKeyBasis === "NAME") {
    return ca.matchKey === cb.matchKey ? "SAME_NAME" : "DIFFERENT";
  }
  // One side has a Lexware contact, the other only a (often OCR) name: compare the names.
  const ka = nameKeyOf(a);
  const kb = nameKeyOf(b);
  if (ka === "" || kb === "") return "NOT_COMPARABLE";
  return ka === kb ? "SAME_NAME" : "DIFFERENT";
}

function evidenceOf(a: Facts, b: Facts, config: DuplicateConfig): PairEvidence {
  const fileHash: MatchEvidence =
    a.hashes.size === 0 || b.hashes.size === 0 ? "NOT_COMPARABLE" : [...a.hashes].some((h) => b.hashes.has(h)) ? "SAME" : "DIFFERENT";
  const voucherNumber: MatchEvidence =
    a.numberKey === null || b.numberKey === null ? "NOT_COMPARABLE" : a.numberKey === b.numberKey ? "SAME" : "DIFFERENT";
  const amount: MatchEvidence =
    a.amount === null || b.amount === null || a.amount.currency !== b.amount.currency
      ? "NOT_COMPARABLE"
      : a.amount.cents === b.amount.cents
        ? "SAME"
        : "DIFFERENT";
  let dayDistance: number | null = null;
  let voucherDayEvidence: DayEvidence = "NOT_COMPARABLE";
  if (a.day !== null && b.day !== null) {
    dayDistance = Math.abs(daysBetween(a.day, b.day));
    voucherDayEvidence = dayDistance === 0 ? "SAME_DAY" : dayDistance <= config.windowDays ? "WITHIN_WINDOW" : "OUTSIDE_WINDOW";
  }
  return {
    fileHash,
    counterparty: compareCounterparty(a.record, b.record),
    voucherNumber,
    amount,
    voucherDay: voucherDayEvidence,
    dayDistance,
    unreviewedInvolved: a.unreviewed || b.unreviewed,
  };
}

function ruleFor(e: PairEvidence): DuplicateRuleId | null {
  const sameParty = e.counterparty === "SAME_CONTACT_ID" || e.counterparty === "SAME_NAME";
  const otherParty = e.counterparty === "DIFFERENT" || e.counterparty === "NOT_COMPARABLE";
  const near = e.voucherDay === "SAME_DAY" || e.voucherDay === "WITHIN_WINDOW";
  if (e.fileHash === "SAME") return "E1";
  if (sameParty && e.voucherNumber === "SAME" && e.amount === "SAME" && e.voucherDay === "SAME_DAY") return "E2";
  if (sameParty && e.voucherNumber === "SAME" && e.amount === "SAME") return "P1";
  if (sameParty && e.voucherNumber === "SAME") return "S2";
  if (otherParty && e.voucherNumber === "SAME" && e.amount === "SAME" && near) return "S3";
  if (sameParty && e.amount === "SAME" && near && e.voucherNumber !== "DIFFERENT") return "S1";
  return null;
}

function reasonsOf(e: PairEvidence): DuplicateReasonCode[] {
  const out: DuplicateReasonCode[] = [];
  out.push(e.fileHash === "SAME" ? "SAME_FILE_HASH" : e.fileHash === "DIFFERENT" ? "FILE_HASH_DIFFERS" : "FILE_HASH_NOT_COMPARABLE");
  out.push(
    e.counterparty === "SAME_CONTACT_ID"
      ? "SAME_CONTACT_ID"
      : e.counterparty === "SAME_NAME"
        ? "SAME_COUNTERPARTY_NAME"
        : e.counterparty === "DIFFERENT"
          ? "COUNTERPARTY_DIFFERS"
          : "COUNTERPARTY_NOT_COMPARABLE",
  );
  out.push(
    e.voucherNumber === "SAME" ? "SAME_VOUCHER_NUMBER" : e.voucherNumber === "DIFFERENT" ? "VOUCHER_NUMBER_DIFFERS" : "VOUCHER_NUMBER_NOT_COMPARABLE",
  );
  out.push(e.amount === "SAME" ? "SAME_AMOUNT" : e.amount === "DIFFERENT" ? "AMOUNT_DIFFERS" : "AMOUNT_NOT_COMPARABLE");
  out.push(
    e.voucherDay === "SAME_DAY"
      ? "SAME_VOUCHER_DAY"
      : e.voucherDay === "WITHIN_WINDOW"
        ? "WITHIN_DAY_WINDOW"
        : e.voucherDay === "OUTSIDE_WINDOW"
          ? "OUTSIDE_DAY_WINDOW"
          : "VOUCHER_DAY_NOT_COMPARABLE",
  );
  if (e.unreviewedInvolved) out.push("UNREVIEWED_INVOLVED");
  return out;
}

function pairable(a: FinanceRecord, b: FinanceRecord): boolean {
  return a.id !== b.id && a.kind === b.kind && a.role === b.role && eligibility(a) === "ELIGIBLE" && eligibility(b) === "ELIGIBLE";
}

function classifyFacts(a: Facts, b: Facts, config: DuplicateConfig): PairResult {
  const [x, y] = compareCodeUnits(a.record.id, b.record.id) <= 0 ? [a, b] : [b, a];
  const evidence = evidenceOf(x, y, config);
  const rule = pairable(x.record, y.record) ? ruleFor(evidence) : null;
  return {
    classification: rule === null ? "NOT_DUPLICATE" : DUPLICATE_RULES[rule].classification,
    rule,
    recordIds: [x.record.id, y.record.id],
    reasonCodes: reasonsOf(evidence),
    evidence,
  };
}

/**
 * Classify one pair. Records of different kind or role, the same id, non-financial, voided or draft records are
 * never duplicates of each other (NOT_DUPLICATE). Symmetric: classifyPair(a, b) and classifyPair(b, a) agree.
 */
export function classifyPair(a: FinanceRecord, b: FinanceRecord, config: Partial<DuplicateConfig> = {}): PairResult {
  return classifyFacts(factsOf(a), factsOf(b), resolveDuplicateConfig(config));
}

type Eligibility = "ELIGIBLE" | "NON_FINANCIAL" | "UNKNOWN_KIND" | "VOIDED" | "DRAFT";

function eligibility(record: FinanceRecord): Eligibility {
  if (record.kind === "NON_FINANCIAL") return "NON_FINANCIAL";
  if (record.kind === "UNKNOWN") return "UNKNOWN_KIND";
  if (record.statusCategory === "VOIDED") return "VOIDED";
  if (record.statusCategory === "DRAFT") return "DRAFT";
  return "ELIGIBLE";
}

export interface DuplicateAnalysis {
  /** Pairs classified EXACT/PROBABLE/POSSIBLE, most severe first; NOT_DUPLICATE pairs are only counted. */
  readonly findings: ReadonlyArray<PairResult>;
  readonly counts: Readonly<Record<Exclude<DuplicateClass, "NOT_DUPLICATE">, number>>;
  readonly pairsEvaluated: number;
  /** False when the pair cap was reached: the result is a lower bound. */
  readonly complete: boolean;
  readonly limitReason: "PAIR_LIMIT" | null;
  readonly recordsConsidered: number;
  readonly excluded: Readonly<Record<Exclude<Eligibility, "ELIGIBLE">, number>>;
  /** Eligible records lacking a comparable value (they can only match via other signals). */
  readonly notComparable: {
    readonly amount: number;
    readonly counterparty: number;
    readonly voucherNumber: number;
    readonly voucherDay: number;
  };
  /** Eligible records with at least one attachment hash (hash rule E1 can only fire between these). */
  readonly recordsWithFileHash: number;
  /** Repeated input ids (the same Lexware document is never its own duplicate). */
  readonly repeatedIdsDropped: number;
  readonly config: DuplicateConfig;
}

const CLASS_RANK: Readonly<Record<DuplicateClass, number>> = {
  EXACT_DUPLICATE: 0,
  PROBABLE_DUPLICATE: 1,
  POSSIBLE_DUPLICATE: 2,
  NOT_DUPLICATE: 3,
};

/** Analyze all eligible records. Deterministic: the result does not depend on input order. */
export function analyzeDuplicates(records: ReadonlyArray<FinanceRecord>, config: Partial<DuplicateConfig> = {}): DuplicateAnalysis {
  const cfg = resolveDuplicateConfig(config);
  const { records: unique, repeatsDropped } = uniqueById(records);
  const excluded = { NON_FINANCIAL: 0, UNKNOWN_KIND: 0, VOIDED: 0, DRAFT: 0 };
  const notComparable = { amount: 0, counterparty: 0, voucherNumber: 0, voucherDay: 0 };
  const facts: Facts[] = [];
  for (const record of unique) {
    const e = eligibility(record);
    if (e !== "ELIGIBLE") {
      excluded[e] += 1;
      continue;
    }
    const f = factsOf(record);
    facts.push(f);
    if (f.amount === null) notComparable.amount += 1;
    if (record.counterparty.matchKeyBasis === "NONE") notComparable.counterparty += 1;
    if (f.numberKey === null) notComparable.voucherNumber += 1;
    if (f.day === null) notComparable.voucherDay += 1;
  }

  // Blocking: every rule needs a shared hash, a shared voucher number or a shared (counterparty, amount).
  // Name-based and contact-id-based counterparties are joined through the normalized name, too.
  const buckets = new Map<string, Facts[]>();
  const put = (key: string, f: Facts) => {
    const list = buckets.get(key);
    if (list) list.push(f);
    else buckets.set(key, [f]);
  };
  const scope = (r: { kind: FinanceKind; role: DocumentRole }) => `${r.kind}|${r.role}`;
  for (const f of facts) {
    const s = scope(f.record);
    for (const h of f.hashes) put(`${s}|hash|${h}`, f);
    if (f.numberKey !== null) put(`${s}|num|${f.numberKey}`, f);
    if (f.amount !== null) {
      const money = `${f.amount.currency}|${f.amount.cents}`;
      if (f.record.counterparty.matchKey !== null) put(`${s}|cp|${f.record.counterparty.matchKey}|${money}`, f);
      const nameKey = nameKeyOf(f.record);
      if (nameKey !== "" && f.record.counterparty.matchKeyBasis !== "NONE") put(`${s}|name|${nameKey}|${money}`, f);
    }
  }

  const seen = new Set<string>();
  const findings: PairResult[] = [];
  let complete = true;
  for (const key of [...buckets.keys()].sort(compareCodeUnits)) {
    const list = buckets.get(key) ?? [];
    for (let i = 0; i < list.length && complete; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        // Length-prefixed so that no pair of ids can produce the same key as another pair.
        const pairKey = `${list[i].record.id.length}:${list[i].record.id}|${list[j].record.id}`;
        if (seen.has(pairKey)) continue;
        if (seen.size >= cfg.maxPairs) {
          complete = false;
          break;
        }
        seen.add(pairKey);
        const result = classifyFacts(list[i], list[j], cfg);
        if (result.classification !== "NOT_DUPLICATE") findings.push(result);
      }
    }
    if (!complete) break;
  }

  findings.sort(
    (a, b) =>
      CLASS_RANK[a.classification] - CLASS_RANK[b.classification] ||
      DUPLICATE_RULE_IDS.indexOf(a.rule as DuplicateRuleId) - DUPLICATE_RULE_IDS.indexOf(b.rule as DuplicateRuleId) ||
      compareCodeUnits(a.recordIds[0], b.recordIds[0]) ||
      compareCodeUnits(a.recordIds[1], b.recordIds[1]),
  );
  const counts = { EXACT_DUPLICATE: 0, PROBABLE_DUPLICATE: 0, POSSIBLE_DUPLICATE: 0 };
  for (const f of findings) counts[f.classification as keyof typeof counts] += 1;

  return {
    findings,
    counts,
    pairsEvaluated: seen.size,
    complete,
    limitReason: complete ? null : "PAIR_LIMIT",
    recordsConsidered: facts.length,
    excluded,
    notComparable,
    recordsWithFileHash: facts.filter((f) => f.hashes.size > 0).length,
    repeatedIdsDropped: repeatsDropped,
    config: cfg,
  };
}
