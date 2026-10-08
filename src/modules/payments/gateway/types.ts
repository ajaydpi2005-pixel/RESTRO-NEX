/**
 * Phase 10 — payment provider abstraction.
 *
 * Every payment row carries a `provider`. Today only `manual` (cash, UPI,
 * card and other methods recorded by staff at the counter) is live. Online
 * gateways are described here so the ledger can grow into them, but an
 * adapter that is not connected must never report success.
 */

export type PaymentProviderKey = "manual" | "razorpay";

export interface PaymentProviderStatus {
  key: PaymentProviderKey;
  label: string;
  connected: boolean;
  /** Plain-language reason shown to staff. */
  reason: string;
}

export interface PaymentProviderAdapter {
  readonly key: PaymentProviderKey;
  status(): PaymentProviderStatus;
}
