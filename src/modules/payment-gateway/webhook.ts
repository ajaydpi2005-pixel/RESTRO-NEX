import { sha256Hex } from "@/modules/online/security";
import type { PaymentProviderAdapter } from "./registry";

/**
 * Phase 17 — provider webhook receiver logic, with its dependencies injected.
 *
 * Order of checks (each stops the request):
 *  1. Unknown provider → 404. The body is not read.
 *  2. Signing secret missing → 503. Nothing is verified or recorded.
 *  3. Body larger than the limit → 413.
 *  4. Signature invalid → 401. Nothing is recorded.
 *  5. Event claimed in payment_webhook_claim:
 *       new → 200, recorded as received
 *       duplicate → 200 (the provider retries, and a replay must be harmless)
 *       mismatch → 409 (same event id, different payload: refuse)
 *
 * This handler never changes an order or a payment. Applying a verified event to
 * money is a separate step that a later phase adds, behind its own checks.
 */

export const WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;

export type ClaimResult = "new" | "duplicate" | "mismatch";

export interface WebhookDeps {
  lookup: (provider: string) => PaymentProviderAdapter | null;
  readSecret: (envName: string) => string | undefined;
  claim: (input: {
    provider: string;
    eventId: string;
    eventType: string;
    payloadSha256: string;
  }) => Promise<ClaimResult>;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handlePaymentWebhook(
  provider: string,
  request: Request,
  deps: WebhookDeps,
): Promise<Response> {
  const adapter = deps.lookup(provider);
  if (!adapter) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const secret = deps.readSecret(adapter.webhookSecretEnv);
  if (!secret) {
    return json(503, { error: "Payments are not configured for this provider." });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > WEBHOOK_BODY_LIMIT_BYTES) {
    return json(413, { error: "The request is too large." });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_BODY_LIMIT_BYTES) {
    return json(413, { error: "The request is too large." });
  }

  const verified = adapter.verifyWebhook({ rawBody, headers: request.headers, secret });
  if (!verified.ok) {
    return json(401, { error: "Signature could not be verified." });
  }

  const result = await deps.claim({
    provider: adapter.key,
    eventId: verified.event.eventId,
    eventType: verified.event.eventType,
    payloadSha256: sha256Hex(rawBody),
  });

  if (result === "mismatch") {
    return json(409, { error: "This event id was already used for a different payload." });
  }
  return json(200, { received: true, duplicate: result === "duplicate" });
}
