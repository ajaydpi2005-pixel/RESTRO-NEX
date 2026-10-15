import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Phase 18 — credential encryption. AES-256-GCM, with the account id as additional
 * authenticated data (AAD). A ciphertext copied to another account therefore fails to
 * decrypt, and so does a tampered one.
 *
 * Format: `v1:<iv base64>:<tag base64>:<ciphertext base64>`. This matches the database
 * check on `integration_secrets.ciphertext`.
 *
 * The key comes from INTEGRATION_ENCRYPTION_KEY: 32 random bytes, base64-encoded. It is
 * server-only and is never stored in the database or logged.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CryptoConfigError extends Error {}
export class CredentialDecryptError extends Error {}

export function parseEncryptionKey(keyBase64: string | undefined): Buffer {
  if (!keyBase64) {
    throw new CryptoConfigError(
      "INTEGRATION_ENCRYPTION_KEY is not set. Generate 32 random bytes, base64-encoded.",
    );
  }
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError("INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

function aadFor(accountId: string): Buffer {
  if (!UUID_RE.test(accountId)) throw new CryptoConfigError("Invalid account id for encryption.");
  return Buffer.from(`integration:${accountId.toLowerCase()}`, "utf8");
}

export function encryptCredentials(
  plaintext: Record<string, string>,
  accountId: string,
  key: Buffer,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadFor(accountId));
  const ct = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptCredentials(
  ciphertext: string,
  accountId: string,
  key: Buffer,
): Record<string, string> {
  const parts = ciphertext.split(":");
  const [version, ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 4 || version !== VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new CredentialDecryptError("Unsupported credential format.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAAD(aadFor(accountId));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(pt);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CredentialDecryptError("Stored credentials are malformed.");
    }
    return parsed as Record<string, string>;
  } catch (error) {
    if (error instanceof CredentialDecryptError) throw error;
    // Do not say which check failed: that would help an attacker probe the key or AAD.
    throw new CredentialDecryptError("Stored credentials could not be read.");
  }
}

/**
 * A display hint for a secret: the last four characters. Short values show only that
 * a value is set, so a short secret is never effectively revealed.
 */
export function secretHint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 12) return "set";
  return `…${trimmed.slice(-4)}`;
}
