import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Phase 17 — webhook signature verification primitives.
 *
 * A provider adapter (added in the external integration phase) calls these
 * helpers with the raw request body, never a re-serialised object. Re-serialising
 * changes whitespace and key order, so a valid signature would fail.
 */

/** Secrets shorter than this are refused. Missing or weak secrets never verify. */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

export function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Constant-time check of an HMAC-SHA256 hex signature over the raw body.
 * Returns false for a missing secret, a malformed signature or a mismatch.
 */
export function verifyHmacSha256Hex(input: {
  rawBody: string;
  signatureHex: string | null | undefined;
  secret: string | null | undefined;
}): boolean {
  const { rawBody, signatureHex, secret } = input;
  if (!secret || secret.length < MIN_WEBHOOK_SECRET_LENGTH) return false;
  if (!signatureHex || !/^[0-9a-f]{64}$/i.test(signatureHex)) return false;

  const expected = Buffer.from(hmacSha256Hex(secret, rawBody), "hex");
  const received = Buffer.from(signatureHex.toLowerCase(), "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
