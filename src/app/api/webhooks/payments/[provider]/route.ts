import { createAdminClient } from "@/lib/supabase/admin";
import { getPaymentProvider } from "@/modules/payment-gateway/registry";
import { handlePaymentWebhook } from "@/modules/payment-gateway/webhook";

/**
 * Phase 17 — payment provider webhook receiver. No provider is registered yet, so
 * every request gets a 404 before its body is read. The verification, signing-secret
 * and idempotency path is built and tested so that a provider adapter can be added
 * without changing this route.
 */

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;

  return handlePaymentWebhook(provider, request, {
    lookup: (key) => getPaymentProvider(key),
    readSecret: (envName) => process.env[envName] || undefined,
    claim: async ({ provider: key, eventId, eventType, payloadSha256 }) => {
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("payment_webhook_claim", {
        p_provider: key,
        p_event_id: eventId,
        p_event_type: eventType,
        p_payload_sha256: payloadSha256,
      });
      if (error || (data !== "new" && data !== "duplicate" && data !== "mismatch")) {
        throw new Error("Webhook claim failed");
      }
      return data;
    },
  });
}
