/**
 * Phase 15 — customer identity. The database links an order to a customer by
 * this key (public.customer_phone_key). Keep the two in step.
 */

/** Digits that identify a customer: the last 10 digits, or all digits when shorter. Null under 7 digits. */
export function customerPhoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  if (digits.length >= 7) return digits;
  return null;
}

/** Same character set the database accepts for a stored phone. */
export const PHONE_PATTERN = /^[+0-9 ()-]{6,20}$/;
