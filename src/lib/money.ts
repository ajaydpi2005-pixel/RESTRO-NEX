/**
 * Money handling — integer minor units only (paise for INR).
 *
 * Floats never touch money in RestroNex:
 *  - user input is parsed from its string form, digit by digit;
 *  - every intermediate value must be a safe integer, otherwise we throw;
 *  - display formatting uses BigInt so it stays exact for any value we accept.
 */

const AMOUNT_PATTERN = /^(\d{1,11})(?:\.(\d{1,2}))?$/;

/**
 * Parse a user-entered amount ("1,234.5", "₹ 99.99", "120") into minor units.
 * Returns null for anything that is not an exact, non-negative amount with at
 * most two decimal places. Never uses floating point arithmetic.
 */
export function parseMoneyToMinor(input: string | null | undefined): number | null {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().replace(/^₹\s*/, "").replace(/,/g, "").replace(/\s+/g, "");
  const match = AMOUNT_PATTERN.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100 + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Assert a value is a safe integer count of minor units and return it. */
export function assertMinor(value: number, label = "Amount"): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a whole number of minor units.`);
  }
  return value;
}

/** Exact sum of minor-unit values; throws if any step leaves the safe range. */
export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertMinor(value);
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError("Money total left the safe integer range.");
    }
  }
  return total;
}

/**
 * Minor units → display text with exactly two decimals and Indian digit
 * grouping, e.g. 123450 → "1,234.50". Uses BigInt so no precision is lost.
 */
export function formatMinor(minor: number): string {
  assertMinor(minor);
  const negative = minor < 0;
  const absolute = BigInt(Math.abs(minor));
  const whole = absolute / BigInt(100);
  const fraction = absolute % BigInt(100);
  const grouped = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(whole);
  return `${negative ? "-" : ""}${grouped}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * Minor units → plain decimal text for inputs, e.g. 123450 → "1234.50".
 * No grouping, so the result round-trips through parseMoneyToMinor.
 */
export function minorToDecimalText(minor: number): string {
  assertMinor(minor);
  const negative = minor < 0;
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  return `${negative ? "-" : ""}${whole}.${String(fraction).padStart(2, "0")}`;
}
