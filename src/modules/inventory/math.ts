/**
 * Phase 13 — pure stock and cost rules shown on the inventory screens.
 * Money is in minor units (paise), matching the database.
 */

export type StockStatus = "out" | "low" | "ok" | "over";

/**
 * Stock health for one ingredient at one outlet. Negative or zero stock is
 * "out" (a sale may already have drawn more than was received). Thresholds
 * are optional; a missing minimum never reports "low".
 */
export function stockStatus(input: {
  onHand: number;
  minimum: number | null;
  maximum: number | null;
}): StockStatus {
  if (input.onHand <= 0) return "out";
  if (input.minimum !== null && input.onHand < input.minimum) return "low";
  if (input.maximum !== null && input.onHand > input.maximum) return "over";
  return "ok";
}

export type ExpiryState = "expired" | "expiring" | "ok" | "none";

/**
 * Expiry state for a batch. `today` is an ISO date (YYYY-MM-DD) in the
 * business timezone. Batches expiring within `windowDays` are "expiring".
 */
export function expiryState(expiresOn: string | null, today: string, windowDays = 7): ExpiryState {
  if (!expiresOn) return "none";
  if (expiresOn < today) return "expired";
  const limit = addDays(today, windowDays);
  return expiresOn <= limit ? "expiring" : "ok";
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Standard cost of one recipe line set, in minor units. */
export function recipeCostMinor(lines: readonly { quantity: number; costPerUnit: number }[]): number {
  const total = lines.reduce((sum, line) => sum + line.quantity * line.costPerUnit, 0);
  return Math.round(total * 100) / 100;
}

/** Gross margin % at a price, or null when there is no price to measure against. */
export function marginPct(priceMinor: number, costMinor: number): number | null {
  if (priceMinor <= 0) return null;
  return Math.round(((priceMinor - costMinor) / priceMinor) * 1000) / 10;
}

/** Food cost % of sales, or null when there were no sales. */
export function foodCostPct(costMinor: number, salesMinor: number): number | null {
  if (salesMinor <= 0) return null;
  return Math.round((costMinor / salesMinor) * 1000) / 10;
}

/**
 * Forms take unit costs in rupees; the database stores them in minor units
 * (paise) per unit, keeping four decimals for sub-paise unit costs.
 */
export function rupeesToMinorUnitCost(rupees: number): number {
  return Math.round(rupees * 100 * 10_000) / 10_000;
}

/** Minor-unit unit cost → rupees, trimmed for display (e.g. 60 → 0.6). */
export function unitCostRupees(minorPerUnit: number): number {
  return Math.round((minorPerUnit / 100) * 10_000) / 10_000;
}
