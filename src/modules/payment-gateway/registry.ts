/**
 * Phase 17 — payment provider registry.
 *
 * Phase 17 registers no provider. Live gateways (Razorpay-equivalent) belong to
 * the external integration phase, and each one adds an adapter here. Until then
 * every provider key resolves to null, so the webhook receiver refuses all
 * requests before it reads the body.
 */

export interface VerifiedWebhookEvent {
  eventId: string;
  eventType: string;
}

export type WebhookVerification =
  { ok: true; event: VerifiedWebhookEvent } | { ok: false; reason: string };

export interface PaymentProviderAdapter {
  /** Lower-case key used in the route, for example "razorpay". */
  readonly key: string;
  /** Environment variable that holds the webhook signing secret. */
  readonly webhookSecretEnv: string;
  /** Verifies the signature over the raw body and extracts the event id and type. */
  verifyWebhook(input: { rawBody: string; headers: Headers; secret: string }): WebhookVerification;
}

const ADAPTERS: Readonly<Record<string, PaymentProviderAdapter>> = {};

export function getPaymentProvider(
  key: string,
  adapters: Readonly<Record<string, PaymentProviderAdapter>> = ADAPTERS,
): PaymentProviderAdapter | null {
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(key)) return null;
  return Object.prototype.hasOwnProperty.call(adapters, key) ? (adapters[key] ?? null) : null;
}

export function registeredProviderKeys(
  adapters: Readonly<Record<string, PaymentProviderAdapter>> = ADAPTERS,
): string[] {
  return Object.keys(adapters);
}
