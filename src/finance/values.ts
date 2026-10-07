import type { Candidate, FieldValue, Reason, Source } from "./model.js";

/** A value read verbatim from a structured Lexware field. */
export function structured<T>(value: T, source: Source): FieldValue<T> {
  return { value, quality: "STRUCTURED", source };
}

/** A value computed deterministically from STRUCTURED values; `reason` names the rule. */
export function derived<T>(value: T, reason: Reason): FieldValue<T> {
  return { value, quality: "DERIVED", source: "derived", reason };
}

/** A value taken from untrusted content (e.g. PDF text). Never a fact. */
export function unverified<T>(value: T, source: Source): FieldValue<T> {
  return { value, quality: "UNVERIFIED", source };
}

/** No value available. */
export function missing<T>(reason: Reason, source: Source | null = null): FieldValue<T> {
  return { value: null, quality: "MISSING", source, reason };
}

/** Lexware returned something known not to be meaningful here; keep it for audit, never use it. */
export function placeholder<T>(raw: T, reason: Reason, source: Source): FieldValue<T> {
  return { value: null, quality: "PLACEHOLDER", source, reason, raw };
}

/** Sources disagree: keep every candidate, use none. */
export function conflict<T>(candidates: ReadonlyArray<Candidate<T>>): FieldValue<T> {
  return { value: null, quality: "CONFLICT", source: null, reason: "SOURCES_DISAGREE", candidates };
}

/** True when the value may be used as a fact (STRUCTURED or DERIVED). UNVERIFIED is deliberately excluded. */
export function isUsable<T>(field: FieldValue<T>): field is FieldValue<T> & { value: T } {
  return (field.quality === "STRUCTURED" || field.quality === "DERIVED") && field.value !== null;
}
