import { describe, expect, it, vi } from "vitest";
import { handlePaymentWebhook, WEBHOOK_BODY_LIMIT_BYTES, type WebhookDeps } from "./webhook";
import {
  getPaymentProvider,
  registeredProviderKeys,
  type PaymentProviderAdapter,
} from "./registry";
import { hmacSha256Hex, verifyHmacSha256Hex } from "./verifier";

const SECRET = "whsec_test_0123456789abcdef";
const BODY = JSON.stringify({ event: "payment.captured", id: "evt_1", amount: 1000 });

/** A test-only adapter. It is not registered in the real registry. */
const testAdapter: PaymentProviderAdapter = {
  key: "testpay",
  webhookSecretEnv: "TESTPAY_WEBHOOK_SECRET",
  verifyWebhook({ rawBody, headers, secret }) {
    if (!verifyHmacSha256Hex({ rawBody, signatureHex: headers.get("x-signature"), secret })) {
      return { ok: false, reason: "bad signature" };
    }
    const parsed = JSON.parse(rawBody) as { event: string; id: string };
    return { ok: true, event: { eventId: parsed.id, eventType: parsed.event } };
  },
};

function makeRequest(body: string, signature?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (signature) headers["x-signature"] = signature;
  return new Request("https://shop.example/api/webhooks/payments/testpay", {
    method: "POST",
    headers,
    body,
  });
}

function deps(overrides: Partial<WebhookDeps> = {}) {
  const claim = vi.fn<WebhookDeps["claim"]>(async () => "new");
  const d: WebhookDeps = {
    lookup: (key) => (key === "testpay" ? testAdapter : null),
    readSecret: (name) => (name === "TESTPAY_WEBHOOK_SECRET" ? SECRET : undefined),
    claim,
    ...overrides,
  };
  return { d, claim };
}

describe("payment-gateway: verifier", () => {
  it("accepts the correct signature over the exact raw body", () => {
    expect(
      verifyHmacSha256Hex({
        rawBody: BODY,
        signatureHex: hmacSha256Hex(SECRET, BODY),
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("rejects a changed body, a wrong secret, a malformed or missing signature", () => {
    const sig = hmacSha256Hex(SECRET, BODY);
    expect(verifyHmacSha256Hex({ rawBody: BODY + " ", signatureHex: sig, secret: SECRET })).toBe(
      false,
    );
    expect(
      verifyHmacSha256Hex({ rawBody: BODY, signatureHex: sig, secret: "another_secret_value" }),
    ).toBe(false);
    expect(verifyHmacSha256Hex({ rawBody: BODY, signatureHex: "abc", secret: SECRET })).toBe(false);
    expect(verifyHmacSha256Hex({ rawBody: BODY, signatureHex: null, secret: SECRET })).toBe(false);
  });

  it("refuses to verify with a missing or weak secret", () => {
    const sig = hmacSha256Hex("short", BODY);
    expect(verifyHmacSha256Hex({ rawBody: BODY, signatureHex: sig, secret: "short" })).toBe(false);
    expect(verifyHmacSha256Hex({ rawBody: BODY, signatureHex: sig, secret: undefined })).toBe(
      false,
    );
  });
});

describe("payment-gateway: registry", () => {
  it("registers no provider in Phase 17, so every key resolves to null", () => {
    expect(registeredProviderKeys()).toEqual([]);
    expect(getPaymentProvider("razorpay")).toBeNull();
    expect(getPaymentProvider("testpay")).toBeNull();
  });

  it("rejects malformed keys and inherited object properties", () => {
    const table = { testpay: testAdapter };
    expect(getPaymentProvider("testpay", table)).toBe(testAdapter);
    expect(getPaymentProvider("../etc", table)).toBeNull();
    expect(getPaymentProvider("constructor", table)).toBeNull();
    expect(getPaymentProvider("__proto__", table)).toBeNull();
  });
});

describe("payment-gateway: webhook receiver", () => {
  it("returns 404 for an unknown provider without reading the body", async () => {
    const { d, claim } = deps();
    const body = { text: vi.fn(async () => "x") } as unknown as Request;
    const res = await handlePaymentWebhook("unknown", body, d);
    expect(res.status).toBe(404);
    expect(body.text).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("returns 503 when the signing secret is not configured, and records nothing", async () => {
    const { d, claim } = deps({ readSecret: () => undefined });
    const res = await handlePaymentWebhook(
      "testpay",
      makeRequest(BODY, hmacSha256Hex(SECRET, BODY)),
      d,
    );
    expect(res.status).toBe(503);
    expect(claim).not.toHaveBeenCalled();
  });

  it("returns 401 for a bad signature and records nothing", async () => {
    const { d, claim } = deps();
    const res = await handlePaymentWebhook("testpay", makeRequest(BODY, "0".repeat(64)), d);
    expect(res.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });

  it("refuses oversize bodies before verification", async () => {
    const { d, claim } = deps();
    const big = JSON.stringify({
      event: "x",
      id: "evt_big",
      pad: "x".repeat(WEBHOOK_BODY_LIMIT_BYTES),
    });
    const res = await handlePaymentWebhook(
      "testpay",
      makeRequest(big, hmacSha256Hex(SECRET, big)),
      d,
    );
    expect(res.status).toBe(413);
    expect(claim).not.toHaveBeenCalled();
  });

  it("claims a valid new event and returns 200", async () => {
    const { d, claim } = deps();
    const res = await handlePaymentWebhook(
      "testpay",
      makeRequest(BODY, hmacSha256Hex(SECRET, BODY)),
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: false });
    expect(claim).toHaveBeenCalledWith({
      provider: "testpay",
      eventId: "evt_1",
      eventType: "payment.captured",
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("treats a replay as a harmless duplicate and returns 200", async () => {
    const { d } = deps({ claim: async () => "duplicate" });
    const res = await handlePaymentWebhook(
      "testpay",
      makeRequest(BODY, hmacSha256Hex(SECRET, BODY)),
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
  });

  it("refuses the same event id with a different payload (409)", async () => {
    const { d } = deps({ claim: async () => "mismatch" });
    const res = await handlePaymentWebhook(
      "testpay",
      makeRequest(BODY, hmacSha256Hex(SECRET, BODY)),
      d,
    );
    expect(res.status).toBe(409);
  });

  it("never reports success just because a request arrived", async () => {
    const { d } = deps();
    const res = await handlePaymentWebhook("testpay", makeRequest(BODY), d);
    expect(res.status).toBe(401);
  });
});
