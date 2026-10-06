/**
 * Exact conversion of Lexware decimal amounts to integer cents.
 *
 * Lexware returns amounts as JSON numbers with (normally) at most two decimals. Multiplying by 100 in
 * floating point can be off by one cent (e.g. 1.005 * 100 = 100.49999…), so the conversion works on the
 * shortest decimal representation of the number instead. More than two decimals is rounded half away from
 * zero and reported via `precisionReduced` — never hidden.
 */

/** Largest absolute amount accepted (well inside Number.MAX_SAFE_INTEGER cents). */
export const MAX_ABS_AMOUNT = 1e12;

export type AmountParse =
  | { readonly ok: true; readonly cents: number; readonly precisionReduced: boolean }
  | { readonly ok: false; readonly reason: "FIELD_ABSENT" | "INVALID_TYPE" | "NOT_FINITE" | "UNSAFE_AMOUNT" };

export function parseAmountToCents(raw: unknown): AmountParse {
  if (raw === undefined || raw === null) return { ok: false, reason: "FIELD_ABSENT" };
  // Only JSON numbers: a string amount would be an unexpected API shape, so it is refused rather than guessed.
  if (typeof raw !== "number") return { ok: false, reason: "INVALID_TYPE" };
  if (!Number.isFinite(raw)) return { ok: false, reason: "NOT_FINITE" };
  if (Math.abs(raw) > MAX_ABS_AMOUNT) return { ok: false, reason: "UNSAFE_AMOUNT" };

  const negative = raw < 0;
  const repr = Math.abs(raw).toString();

  let cents: number;
  let precisionReduced = false;

  if (/e/i.test(repr)) {
    // Only reachable for magnitudes below 1e-6 (large values are rejected above): effectively zero cents.
    const scaled = Math.abs(raw) * 100;
    cents = Math.round(scaled);
    precisionReduced = scaled !== cents;
  } else {
    const [intPart, fracPart = ""] = repr.split(".");
    cents = Number(intPart) * 100 + Number(fracPart.slice(0, 2).padEnd(2, "0"));
    if (fracPart.length > 2) {
      precisionReduced = /[1-9]/.test(fracPart.slice(2));
      if (fracPart.charCodeAt(2) >= "5".charCodeAt(0)) cents += 1;
    }
  }

  if (!Number.isSafeInteger(cents)) return { ok: false, reason: "UNSAFE_AMOUNT" };
  return { ok: true, cents: negative && cents !== 0 ? -cents : cents, precisionReduced };
}
