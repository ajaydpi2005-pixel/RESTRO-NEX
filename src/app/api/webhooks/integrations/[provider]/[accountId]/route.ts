import { createHash } from "node:crypto";
import { getServerEnv } from "@/lib/env";
import { findProvider, type ProviderKey } from "@/modules/integrations/catalog";
import {
  loadRuntimeAccount,
  readCredentials,
  rpc,
  IntegrationServiceError,
} from "@/modules/integrations/service";
import {
  metaEventIds,
  payloadEventId,
  secretsMatch,
  verifyMeta,
  verifyRazorpay,
  verifySvix,
  verifyTwilio,
  type VerifyResult,
} from "@/modules/integrations/signatures";
import type { RuntimeAccount } from "@/modules/integrations/worker";

/**
 * Phase 18 — inbound provider webhooks for live connections.
 *
 *   POST /api/webhooks/integrations/{provider}/{accountId}
 *   GET  same path — WhatsApp (Meta) subscription challenge only
 *
 * Order of checks. Each stops the request:
 *   1. Provider has an inbound scheme, and the account exists, is live, is enabled and is
 *      connected. Otherwise 404, which reveals nothing about the account.
 *   2. Body within 64 KB, else 413. The raw body is read before anything is parsed.
 *   3. Signature verified against the account's own secret, else 401. Nothing is recorded.
 *   4. Event claimed once (integration_webhook_claim): new → 200, replay → 200 duplicate,
 *      altered payload under the same id → 409.
 *
 * This route never changes an order, a payment or a customer. A verified event is only
 * recorded. Acting on it is a later step with its own checks.
 *
 * In this build no live connection can be enabled (see the catalogue), so this path is
 * built and tested but not reachable in production yet.
 */

export const dynamic = "force-dynamic";

const BODY_LIMIT = 64 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { provider: string; accountId: string };

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: NO_STORE });
}

function notFound() {
  return new Response(null, { status: 404, headers: NO_STORE });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The secret field each scheme needs, from the account's decrypted credentials. */
const SECRET_FIELD: Partial<Record<ProviderKey, string>> = {
  razorpay: "webhook_secret",
  email: "webhook_secret",
  whatsapp: "app_secret",
  sms: "auth_token",
};

async function loadAccount(
  params: Params,
  options: { requireEnabled: boolean },
): Promise<{ account: RuntimeAccount; credentials: Record<string, string> } | null> {
  const def = findProvider(params.provider);
  if (!def || !def.webhook || !UUID_RE.test(params.accountId)) return null;

  let account: RuntimeAccount | null;
  try {
    account = await loadRuntimeAccount(params.accountId);
  } catch {
    return null;
  }
  if (!account || account.provider !== def.key || account.mode !== "live") return null;
  if (options.requireEnabled && (!account.enabled || account.status !== "connected")) return null;

  let credentials: Record<string, string>;
  try {
    credentials = readCredentials(account);
  } catch {
    return null;
  }
  return { account, credentials };
}

/** Meta's one-time subscription check: echo the challenge when the verify token matches. */
export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  const resolved = await params;
  if (resolved.provider !== "whatsapp") return notFound();

  const url = new URL(request.url);
  const loaded = await loadAccount(resolved, { requireEnabled: false });
  if (!loaded) return notFound();

  const expected = loaded.credentials.verify_token;
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (
    url.searchParams.get("hub.mode") !== "subscribe" ||
    !expected ||
    !secretsMatch(token, expected) ||
    challenge.length === 0 ||
    challenge.length > 200
  ) {
    return new Response("Forbidden", { status: 403, headers: NO_STORE });
  }
  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE },
  });
}

export async function POST(request: Request, { params }: { params: Promise<Params> }) {
  const resolved = await params;
  const loaded = await loadAccount(resolved, { requireEnabled: true });
  if (!loaded) return notFound();
  const { account, credentials } = loaded;
  const def = findProvider(resolved.provider);
  if (!def?.webhook) return notFound();

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BODY_LIMIT) {
    return json(413, { error: "The request is too large." });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > BODY_LIMIT) {
    return json(413, { error: "The request is too large." });
  }

  const secretField = SECRET_FIELD[account.provider];
  const secret = secretField ? credentials[secretField] : undefined;
  if (!secret) return json(503, { error: "This integration is not configured for webhooks." });

  const headers = request.headers;
  const payloadHash = sha256Hex(rawBody);
  let verified: VerifyResult;
  switch (def.webhook) {
    case "razorpay":
      verified = verifyRazorpay({
        rawBody,
        signature: headers.get("x-razorpay-signature"),
        eventId: headers.get("x-razorpay-event-id"),
        secret,
      });
      break;
    case "svix":
      verified = verifySvix({
        rawBody,
        id: headers.get("svix-id"),
        timestamp: headers.get("svix-timestamp"),
        signatureHeader: headers.get("svix-signature"),
        secret,
        now: Date.now(),
      });
      break;
    case "meta": {
      verified = verifyMeta({
        rawBody,
        signatureHeader: headers.get("x-hub-signature-256"),
        secret,
      });
      if (verified.ok) {
        const id = metaEventIds(rawBody)[0] ?? payloadEventId("wa", payloadHash);
        verified = { ok: true, eventId: id, eventType: null };
      }
      break;
    }
    case "twilio": {
      // Twilio signs the exact public URL it called. Use the configured app URL, not the
      // request's internal host, when it is set.
      const base = getServerEnv().NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
      const publicUrl = `${base.replace(/\/$/, "")}/api/webhooks/integrations/${resolved.provider}/${resolved.accountId}`;
      verified = verifyTwilio({
        url: publicUrl,
        params: Object.fromEntries(new URLSearchParams(rawBody)),
        signature: headers.get("x-twilio-signature"),
        authToken: secret,
      });
      break;
    }
    default:
      return notFound();
  }

  if (!verified.ok) {
    return json(401, { error: "Signature could not be verified." });
  }
  const eventId = verified.eventId || payloadEventId("evt", payloadHash);

  try {
    const result = await rpc<string>("integration_webhook_claim", {
      p_account_id: account.account_id,
      p_event_id: eventId,
      p_event_type: verified.eventType,
      p_payload_sha256: payloadHash,
      p_summary: {},
    });
    if (result === "mismatch") {
      return json(409, { error: "This event id was already used for a different payload." });
    }
    return json(200, { received: true, duplicate: result === "duplicate" });
  } catch (error) {
    if (error instanceof IntegrationServiceError) {
      return json(400, { error: error.message });
    }
    return json(500, { error: "The event could not be recorded. Try again." });
  }
}
