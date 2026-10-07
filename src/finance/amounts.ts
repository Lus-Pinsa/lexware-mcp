/**
 * Exact arithmetic on integer cents for reports.
 *
 * - Sums never lose precision: a result outside the safe-integer range is reported as not computable (null),
 *   never as a rounded number.
 * - Relative changes are computed with BigInt; a zero base gives "not defined", never Infinity or NaN.
 * - Threshold checks compare exact rationals, so a value exactly on a threshold is decided correctly.
 */

/** a + b, or null when an input or the result is not a safe integer. */
export function addCents(a: number, b: number): number | null {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

/** a − b, or null when an input or the result is not a safe integer. */
export function subtractCents(a: number, b: number): number | null {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  const diff = a - b;
  return Number.isSafeInteger(diff) ? diff : null;
}

export type RelativeChange =
  | { readonly ok: true; readonly tenthsOfPercent: number }
  | { readonly ok: false; readonly reason: "BASE_ZERO" | "NOT_COMPUTABLE" };

/**
 * (current − base) / |base| in tenths of a percent, rounded half away from zero
 * (e.g. +12.25 % → 123, −12.25 % → −123).
 */
export function relativeChange(current: number, base: number): RelativeChange {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(base)) return { ok: false, reason: "NOT_COMPUTABLE" };
  if (base === 0) return { ok: false, reason: "BASE_ZERO" };
  const num = (BigInt(current) - BigInt(base)) * 1000n;
  const den = BigInt(base < 0 ? -base : base);
  let q = num / den;
  const r = num % den;
  const absR = r < 0n ? -r : r;
  if (absR * 2n >= den) q += num < 0n ? -1n : 1n;
  const tenths = Number(q);
  return Number.isSafeInteger(tenths) ? { ok: true, tenthsOfPercent: tenths } : { ok: false, reason: "NOT_COMPUTABLE" };
}

/** Hundredths of a percent for a configured percentage (e.g. 30 → 3000); throws RangeError for unusable values. */
export function percentToHundredths(percent: number): number {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 1_000_000) {
    throw new RangeError("percentage threshold must be a finite number between 0 and 1000000");
  }
  const scaled = Math.round(percent * 100);
  if (Math.abs(scaled - percent * 100) > 1e-6) throw new RangeError("percentage threshold allows at most two decimals");
  return scaled;
}

/** Exact: |current − base| × 100 ≥ thresholdPercent × |base|. False when base is 0 or inputs are unsafe. */
export function relativeChangeAtLeast(current: number, base: number, thresholdHundredths: number): boolean {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(base) || base === 0) return false;
  const diff = BigInt(current) - BigInt(base);
  const absDiff = diff < 0n ? -diff : diff;
  const absBase = BigInt(base < 0 ? -base : base);
  return absDiff * 10_000n >= BigInt(thresholdHundredths) * absBase;
}

/** Exact: |current − base| ≥ thresholdCents. False when inputs are unsafe. */
export function absoluteChangeAtLeast(current: number, base: number, thresholdCents: number): boolean {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(base)) return false;
  const diff = BigInt(current) - BigInt(base);
  const absDiff = diff < 0n ? -diff : diff;
  return absDiff >= BigInt(thresholdCents);
}
