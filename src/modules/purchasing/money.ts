/**
 * Phase 14 — money helpers. Forms take rupees with at most two decimals; the
 * database stores whole paise. Unit costs keep four decimals (see inventory
 * math), so they are converted separately.
 */

/** Rupees (up to 2 decimals) → whole paise. Returns NaN for unusable input. */
export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return Number.NaN;
  return Math.round(rupees * 100);
}

/** True when a rupee amount has at most two decimal places. */
export function hasAtMostTwoDecimals(rupees: number): boolean {
  return Math.abs(rupees * 100 - Math.round(rupees * 100)) < 1e-6;
}

/** Whole paise → display string without trailing .00 (e.g. 12050 → "120.50", 12000 → "120"). */
export function paiseToDisplay(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const text = (abs / 100).toFixed(2).replace(/\.00$/, "");
  return negative ? `-${text}` : text;
}

/** Ordered-vs-billed price variance on a line, in paise (positive = billed above order). */
export function priceVarianceMinor(billedUnitCost: number, orderedUnitCost: number, qty: number): number {
  return Math.round((billedUnitCost - orderedUnitCost) * qty * 100) / 100;
}
