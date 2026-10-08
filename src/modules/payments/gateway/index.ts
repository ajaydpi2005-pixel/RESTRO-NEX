import { manualProvider } from "./manual";
import { razorpayProvider } from "./razorpay";
import type { PaymentProviderStatus } from "./types";

export { manualProvider, razorpayProvider };
export { GatewayNotConnectedError, verifyRazorpayWebhookSignature } from "./razorpay";
export type { PaymentProviderKey, PaymentProviderStatus } from "./types";

/** Honest provider status for the payments settings screen. */
export function listPaymentProviders(): PaymentProviderStatus[] {
  return [manualProvider.status(), razorpayProvider.status()];
}
