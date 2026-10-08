/**
 * ⚠️ PHASE 10 PLACEHOLDER — payment recording abstraction.
 *
 * Phase 8 deliberately collects NO money and talks to NO payment gateway.
 * Orders move to `ready` while `payment_status` stays `pending`. When a
 * payment is recorded in Phase 10, `orders.paid_minor` is advanced and the
 * guarded state machine then permits `ready → completed`.
 *
 * This module is the single seam Phase 10 will implement. It is the ONLY
 * place that may ever set `orders.paid_minor` / `payment_status`.
 */

export type PaymentMethod =
  | "cash"
  | "card"
  | "upi"
  | "wallet"
  | "gift_card"
  | "other";

export interface PaymentRecordInput {
  orderId: string;
  /** money collected, in minor units; must be server-verified in Phase 10 */
  amountMinor: number;
  method: PaymentMethod;
  /** gateway / cash-drawer reference, if any */
  reference: string | null;
}

export interface PaymentRecordResult {
  ok: boolean;
  orderId: string;
  error?: string;
}

/**
 * NOT IMPLEMENTED in Phase 8 — throws if called so nothing can silently
 * fake a payment. Phase 10 replaces the body with a server-side
 * transaction that: verifies the amount against order totals, marks the
 * payment source (gateway capture or cashier attestation), updates
 * `paid_minor` / `payment_status`, and writes an audit row.
 */
// Parameters are the Phase 10 contract; unused until payment collection lands.
export async function recordPayment(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _input: PaymentRecordInput,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actorUserId: string,
): Promise<PaymentRecordResult> {
  throw new Error(
    "Payment collection is not available yet (RestroNex Phase 10). Orders can be placed and tracked, but no money is collected in this phase.",
  );
}

/** Phase 8 orders can never be marked paid. */
export const PAYMENT_COLLECTION_AVAILABLE = false;
