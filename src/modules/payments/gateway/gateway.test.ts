import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GatewayNotConnectedError,
  listPaymentProviders,
  razorpayProvider,
  verifyRazorpayWebhookSignature,
} from "@/modules/payments/gateway";

const SECRET = "whsec_test_only_not_a_secret";
const BODY = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } });
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("Razorpay webhook signature verification", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyRazorpayWebhookSignature({ rawBody: BODY, signatureHeader: sign(BODY), secret: SECRET })).toBe(true);
  });

  it("accepts an upper-case header value", () => {
    expect(
      verifyRazorpayWebhookSignature({ rawBody: BODY, signatureHeader: sign(BODY).toUpperCase(), secret: SECRET }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = BODY.replace("pay_1", "pay_2");
    expect(verifyRazorpayWebhookSignature({ rawBody: tampered, signatureHeader: sign(BODY), secret: SECRET })).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    expect(
      verifyRazorpayWebhookSignature({ rawBody: BODY, signatureHeader: sign(BODY, "other"), secret: SECRET }),
    ).toBe(false);
  });

  it("rejects missing, malformed or truncated signatures", () => {
    expect(verifyRazorpayWebhookSignature({ rawBody: BODY, signatureHeader: null, secret: SECRET })).toBe(false);
    expect(verifyRazorpayWebhookSignature({ rawBody: BODY, signatureHeader: "", secret: SECRET })).toBe(false);
    expect(verifyRazorpayWebhookSignature({ rawBody: BODY, signatureHeader: "abc", secret: SECRET })).toBe(false);
    expect(
      verifyRazorpayWebhookSignature({ rawBody: BODY, signatureHeader: sign(BODY).slice(0, 63), secret: SECRET }),
    ).toBe(false);
  });

  it("fails closed when the secret is not configured", () => {
    expect(verifyRazorpayWebhookSignature({ rawBody: BODY, signatureHeader: sign(BODY), secret: "" })).toBe(false);
    expect(verifyRazorpayWebhookSignature({ rawBody: BODY, signatureHeader: sign(BODY), secret: undefined })).toBe(false);
  });
});

describe("Razorpay adapter (abstraction only)", () => {
  it("reports not connected and never claims success", async () => {
    expect(razorpayProvider.status().connected).toBe(false);
    await expect(razorpayProvider.createOrder()).rejects.toBeInstanceOf(GatewayNotConnectedError);
  });

  it("lists providers honestly: manual live, razorpay not connected", () => {
    const providers = listPaymentProviders();
    expect(providers.find((p) => p.key === "manual")?.connected).toBe(true);
    expect(providers.find((p) => p.key === "razorpay")?.connected).toBe(false);
  });
});
