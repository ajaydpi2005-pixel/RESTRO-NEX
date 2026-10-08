import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentProviderAdapter, PaymentProviderStatus } from "./types";

/**
 * Razorpay — ABSTRACTION ONLY in this build.
 *
 *  - No live API calls exist here. `status()` reports "not connected".
 *  - There is no createOrder/capture path: attempting a charge throws, so a
 *    gateway success can never be fabricated.
 *  - `verifyRazorpayWebhookSignature` is a complete HMAC-SHA256 check with a
 *    constant-time comparison. It is unit-tested but deliberately NOT wired
 *    to any HTTP endpoint yet.
 */

export class GatewayNotConnectedError extends Error {
  constructor(message = "Razorpay is not connected in this build. No payment was taken.") {
    super(message);
    this.name = "GatewayNotConnectedError";
  }
}

export const razorpayProvider: PaymentProviderAdapter & {
  createOrder(): Promise<never>;
} = {
  key: "razorpay",
  status(): PaymentProviderStatus {
    return {
      key: "razorpay",
      label: "Razorpay (online payments)",
      connected: false,
      reason: "Not connected. Online payments are not available in this build.",
    };
  },
  async createOrder(): Promise<never> {
    throw new GatewayNotConnectedError();
  },
};

/**
 * Verify an `X-Razorpay-Signature` header: hex HMAC-SHA256 of the raw request
 * body keyed with the webhook secret. Returns false on any malformed input.
 */
export function verifyRazorpayWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null | undefined;
  secret: string | null | undefined;
}): boolean {
  const { rawBody, signatureHeader, secret } = input;
  if (typeof rawBody !== "string" || typeof signatureHeader !== "string" || !secret) return false;

  const provided = signatureHeader.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
