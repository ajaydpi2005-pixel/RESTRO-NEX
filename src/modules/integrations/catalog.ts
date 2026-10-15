/**
 * Phase 18 — the integration catalogue. Pure data: no server imports, so the settings
 * page, the actions and the tests all read the same definitions.
 *
 * `liveAvailable` is the honest answer to "can this connect to the real service in
 * this build?". Only the printer is true: it goes through the on-site print agent,
 * which talks to the printer on the LAN. Every other provider waits for sandbox keys.
 * Swiggy and Zomato have no self-serve public API, so they are DEMO-only for good
 * (the database refuses live mode for them too).
 *
 * The operation names must match `integration_operation_allowed` in the migration.
 */

export const PROVIDERS = [
  "razorpay",
  "swiggy",
  "zomato",
  "whatsapp",
  "sms",
  "email",
  "printer",
  "accounting_export",
] as const;

export type ProviderKey = (typeof PROVIDERS)[number];
export type IntegrationMode = "demo" | "live";
export type WebhookScheme = "razorpay" | "svix" | "meta" | "twilio";

export interface CredentialField {
  name: string;
  label: string;
  /** Secret fields are encrypted and shown only as a hint (last four characters). */
  secret: boolean;
}

export interface ProviderDefinition {
  key: ProviderKey;
  label: string;
  category: "payments" | "delivery" | "messaging" | "printing" | "accounting";
  description: string;
  operations: readonly string[];
  /** True only when a real, tested live path exists in this build (printer: via the print agent). */
  liveAvailable: boolean;
  /** Why live is unavailable, shown to staff. */
  liveNote: string;
  credentialFields: readonly CredentialField[];
  /** Inbound webhook verification scheme, or null when the provider does not call us. */
  webhook: WebhookScheme | null;
  /** Synchronous file export: no connection, no queue, no network. */
  fileExport?: boolean;
}

const NO_LIVE_YET =
  "Live connection is not built yet. This connection runs in DEMO mode only, and nothing is sent to the provider.";

export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  {
    key: "razorpay",
    label: "Razorpay",
    category: "payments",
    description: "Payment links and payment webhooks.",
    operations: ["payment.create_link"],
    liveAvailable: false,
    liveNote: NO_LIVE_YET,
    credentialFields: [
      { name: "key_id", label: "Key ID", secret: false },
      { name: "key_secret", label: "Key secret", secret: true },
      { name: "webhook_secret", label: "Webhook secret", secret: true },
    ],
    webhook: "razorpay",
  },
  {
    key: "swiggy",
    label: "Swiggy",
    category: "delivery",
    description: "Menu sync and order status. Swiggy has no self-serve API.",
    operations: ["aggregator.sync_menu", "aggregator.push_status"],
    liveAvailable: false,
    liveNote:
      "Swiggy offers live access only through partner onboarding, and no self-serve API exists. This is DEMO only; live mode is blocked.",
    credentialFields: [],
    webhook: null,
  },
  {
    key: "zomato",
    label: "Zomato",
    category: "delivery",
    description: "Menu sync and order status. Zomato has no self-serve API.",
    operations: ["aggregator.sync_menu", "aggregator.push_status"],
    liveAvailable: false,
    liveNote:
      "Zomato offers live access only through partner onboarding, and its public developer API is discontinued. This is DEMO only; live mode is blocked.",
    credentialFields: [],
    webhook: null,
  },
  {
    key: "whatsapp",
    label: "WhatsApp Cloud API",
    category: "messaging",
    description: "Customer messages and inbound replies.",
    operations: ["message.send"],
    liveAvailable: false,
    liveNote: NO_LIVE_YET,
    credentialFields: [
      { name: "access_token", label: "Access token", secret: true },
      { name: "app_secret", label: "App secret (webhook signature)", secret: true },
      { name: "verify_token", label: "Webhook verify token", secret: true },
    ],
    webhook: "meta",
  },
  {
    key: "sms",
    label: "SMS (Twilio)",
    category: "messaging",
    description: "Transactional SMS and delivery status callbacks.",
    operations: ["message.send"],
    liveAvailable: false,
    liveNote: NO_LIVE_YET,
    credentialFields: [
      { name: "account_sid", label: "Account SID", secret: false },
      { name: "auth_token", label: "Auth token", secret: true },
    ],
    webhook: "twilio",
  },
  {
    key: "email",
    label: "Email (Resend)",
    category: "messaging",
    description: "Transactional email and delivery webhooks.",
    operations: ["email.send"],
    liveAvailable: false,
    liveNote: NO_LIVE_YET,
    credentialFields: [
      { name: "api_key", label: "API key", secret: true },
      { name: "webhook_secret", label: "Webhook signing secret (whsec_…)", secret: true },
    ],
    webhook: "svix",
  },
  {
    key: "printer",
    label: "Network printer (ESC/POS)",
    category: "printing",
    description:
      "Kitchen and receipt printers on port 9100. Printer hosts pass an address guard before any connection.",
    operations: ["print.document", "connection.test"],
    liveAvailable: true,
    liveNote:
      "Live printing runs through an on-site print agent on the outlet's LAN. The server never connects to printers directly. Use DEMO to preview the output bytes.",
    credentialFields: [],
    webhook: null,
  },
  {
    key: "accounting_export",
    label: "Accounting CSV export",
    category: "accounting",
    description: "A sales ledger CSV for your accountant. No connection or network is used.",
    operations: [],
    liveAvailable: false,
    liveNote: "This is a file export. It never connects to an accounting service.",
    credentialFields: [],
    webhook: null,
    fileExport: true,
  },
] as const;

export function findProvider(key: string): ProviderDefinition | null {
  return PROVIDER_CATALOG.find((p) => p.key === key) ?? null;
}

/** Live mode is refused by the database for these, and by the UI and actions. */
export function liveBlocked(provider: ProviderDefinition): boolean {
  return !provider.liveAvailable;
}
