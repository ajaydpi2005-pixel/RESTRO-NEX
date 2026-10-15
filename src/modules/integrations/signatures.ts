import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Phase 18 — inbound webhook signature verification, one scheme per provider family.
 * Every function takes the raw body and the secret, and verifies before anything is
 * parsed or trusted. Comparisons are constant-time.
 *
 *  • razorpay — X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook secret)
 *  • svix     — Resend. svix-id / svix-timestamp / svix-signature. Signed content is
 *               "id.timestamp.body", HMAC-SHA256 base64, keyed with the base64 part of
 *               "whsec_…". Multiple "v1," entries are allowed. Timestamps outside the
 *               tolerance are rejected (replay protection).
 *  • meta     — WhatsApp Cloud. X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256(raw
 *               body, app secret).
 *  • twilio   — X-Twilio-Signature = base64 HMAC-SHA1(full URL + sorted POST params,
 *               auth token). The URL must be the public URL Twilio called.
 */

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface VerifiedEvent {
  eventId: string;
  eventType: string | null;
}

export type VerifyResult = ({ ok: true } & VerifiedEvent) | { ok: false; reason: string };

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Short, non-secret fingerprint of a payload, used when a provider gives no event id. */
export function payloadEventId(prefix: string, rawSha256: string): string {
  return `${prefix}-${rawSha256.slice(0, 40)}`;
}

function eventTypeOf(rawBody: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && "event" in parsed) {
      const value = (parsed as { event: unknown }).event;
      if (typeof value === "string" && value.length <= 80) return value;
    }
  } catch {
    // Not JSON: no event type. The signature check has already run.
  }
  return null;
}

// ── Razorpay ───────────────────────────────────────────────────────────────

export function verifyRazorpay(input: {
  rawBody: string;
  signature: string | null;
  eventId: string | null;
  secret: string;
}): VerifyResult {
  if (!input.signature || !input.eventId) return { ok: false, reason: "missing headers" };
  const expected = createHmac("sha256", input.secret).update(input.rawBody, "utf8").digest("hex");
  if (!safeEqual(expected, input.signature.trim().toLowerCase())) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true, eventId: input.eventId, eventType: eventTypeOf(input.rawBody) };
}

// ── Svix (Resend) ──────────────────────────────────────────────────────────

export function verifySvix(input: {
  rawBody: string;
  id: string | null;
  timestamp: string | null;
  signatureHeader: string | null;
  secret: string;
  now: number;
  toleranceSeconds?: number;
}): VerifyResult {
  if (!input.id || !input.timestamp || !input.signatureHeader) {
    return { ok: false, reason: "missing headers" };
  }
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: "bad timestamp" };
  const ts = Number(input.timestamp);
  const tolerance = input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
  if (Math.abs(input.now / 1000 - ts) > tolerance) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  if (!input.secret.startsWith("whsec_")) return { ok: false, reason: "bad secret format" };
  const key = Buffer.from(input.secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key)
    .update(`${input.id}.${input.timestamp}.${input.rawBody}`, "utf8")
    .digest("base64");

  const candidates = input.signatureHeader
    .split(" ")
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));
  const matched = candidates.some((sig) => safeEqual(expected, sig));
  if (!matched) return { ok: false, reason: "signature mismatch" };
  return { ok: true, eventId: input.id, eventType: eventTypeOf(input.rawBody) };
}

// ── WhatsApp Cloud (Meta) ──────────────────────────────────────────────────

export function verifyMeta(input: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
}): VerifyResult {
  if (!input.signatureHeader || !input.signatureHeader.startsWith("sha256=")) {
    return { ok: false, reason: "missing signature" };
  }
  const expected = createHmac("sha256", input.secret).update(input.rawBody, "utf8").digest("hex");
  if (!safeEqual(expected, input.signatureHeader.slice("sha256=".length).toLowerCase())) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true, eventId: "", eventType: null };
}

/** The message or status ids inside a WhatsApp delivery, used as event ids. */
export function metaEventIds(rawBody: string): string[] {
  try {
    const parsed = JSON.parse(rawBody) as {
      entry?: {
        changes?: {
          value?: {
            messages?: { id?: unknown }[];
            statuses?: { id?: unknown; status?: unknown }[];
          };
        }[];
      }[];
    };
    const ids: string[] = [];
    for (const entry of parsed.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          if (typeof m.id === "string") ids.push(m.id);
        }
        for (const s of change.value?.statuses ?? []) {
          if (typeof s.id === "string" && typeof s.status === "string") {
            ids.push(`${s.id}:${s.status}`);
          }
        }
      }
    }
    return ids.filter((id) => id.length <= 160);
  } catch {
    return [];
  }
}

// ── Twilio ─────────────────────────────────────────────────────────────────

/** Twilio's documented algorithm: URL, then each POST key and value in sorted key order. */
export function twilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilio(input: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
  authToken: string;
}): VerifyResult {
  if (!input.signature) return { ok: false, reason: "missing signature" };
  const expected = twilioSignature(input.url, input.params, input.authToken);
  if (!safeEqual(expected, input.signature)) return { ok: false, reason: "signature mismatch" };
  const eventId = input.params.MessageSid || input.params.SmsSid || "";
  if (!eventId || eventId.length > 160) return { ok: false, reason: "missing message id" };
  return { ok: true, eventId, eventType: input.params.MessageStatus ?? null };
}

/** Constant-time comparison for shared secrets such as the worker's bearer token. */
export function secretsMatch(presented: string, expected: string): boolean {
  return safeEqual(presented, expected);
}
