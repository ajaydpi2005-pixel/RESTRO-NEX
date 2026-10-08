import type { PaymentProviderAdapter } from "./types";

/**
 * Staff-recorded payments. Nothing is sent anywhere: the cashier attests the
 * money was received, and the ledger records who did it and when.
 */
export const manualProvider: PaymentProviderAdapter = {
  key: "manual",
  status() {
    return {
      key: "manual",
      label: "Recorded at the counter",
      connected: true,
      reason: "Cash, UPI, card and other methods are recorded by staff. No gateway is contacted.",
    };
  },
};
