import { createHash, randomBytes } from "node:crypto";
import { PUBLIC_BODY_LIMIT_BYTES } from "./constants";

/**
 * Phase 17 — security helpers for the public (unauthenticated) surface.
 *
 *  • Secrets (tracking secrets, printed QR tokens) are random and url-safe.
 *    Only their SHA-256 is stored. A database leak does not reveal a usable link.
 *  • Rate-limit buckets use a hashed client fingerprint, so no IP address is stored.
 *  • Public endpoints use no cookies, so cross-site forgery has nothing to ride on.
 *    The Origin check is defence in depth, and the JSON-only rule limits what a
 *    simple cross-site form can send.
 */

/** Random url-safe token. 32 bytes gives 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Hashed client identity for rate limiting. Raw IPs are never stored. */
export function clientFingerprint(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers.get("x-real-ip")?.trim() || "unknown";
  return sha256Hex(`fp:${ip}`).slice(0, 32);
}

/**
 * True when the request comes from the same origin, or when it carries no Origin
 * header (non-browser clients). A mismatched Origin is refused.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export type BodyResult =
  { ok: true; value: unknown } | { ok: false; status: number; message: string };

/**
 * Reads a bounded JSON body. Refuses other content types, oversize bodies and
 * malformed JSON before any validation runs.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = PUBLIC_BODY_LIMIT_BYTES,
): Promise<BodyResult> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return { ok: false, status: 415, message: "Send the request as JSON." };
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, message: "The request is too large." };
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, status: 413, message: "The request is too large." };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, message: "The request could not be read." };
  }
}

/** Headers for responses that carry customer or order data. Never cached. */
export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
} as const;
