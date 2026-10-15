import { z } from "zod";
import { PROVIDERS, PROVIDER_CATALOG, findProvider, type ProviderKey } from "./catalog";
import { MAX_LINE_CHARS, MAX_LINES, PAPER_WIDTHS } from "./escpos";

/**
 * Phase 18 — input validation for the integration actions and routes. The database
 * re-checks every rule that matters: permissions, outlet scope, live gating and the
 * enqueue test gate. These checks give clear messages and keep bad data out early.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE, "That id is not valid.");

/** Setting keys allowed per provider. Anything else is refused. */
export const CONFIG_KEYS: Record<ProviderKey, readonly string[]> = {
  razorpay: [],
  swiggy: ["outlet_code"],
  zomato: ["outlet_code"],
  whatsapp: ["api_version", "phone_number_id"],
  sms: ["sender_id"],
  email: ["from_address"],
  printer: ["host", "paper_width_chars"],
  accounting_export: [],
};

const CONFIG_KEY_RE = /^[a-z_]{1,40}$/;
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function configValueError(
  provider: ProviderKey,
  key: string,
  value: unknown,
): string | null {
  if (!CONFIG_KEYS[provider].includes(key))
    return `"${key}" is not a setting for this integration.`;
  if (key === "paper_width_chars") {
    const n = typeof value === "number" ? value : Number(value);
    return (PAPER_WIDTHS as readonly number[]).includes(n)
      ? null
      : "Paper width must be 32, 42 or 48 characters.";
  }
  if (key === "host") {
    if (typeof value !== "string" || value.trim() === "")
      return "Enter the printer's IP address or host name.";
    const host = value.trim().toLowerCase();
    const ip = IPV4_RE.exec(host);
    if (ip)
      return ip.slice(1).every((p) => Number(p) <= 255) ? null : "That IP address is not valid.";
    return HOST_RE.test(host) ? null : "That printer host name is not valid.";
  }
  if (key === "from_address") {
    return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
      ? null
      : "Enter a valid sender email address.";
  }
  return typeof value === "string" && value.length <= 200 ? null : "That setting is too long.";
}

const configRecord = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .default({});

export const saveSchema = z.object({
  businessId: uuid,
  accountId: uuid.nullable().optional(),
  outletId: uuid.nullable().optional(),
  provider: z.enum(PROVIDERS, { message: "Choose an integration." }),
  mode: z.enum(["demo", "live"], { message: "Choose DEMO or live." }),
  enabled: z.boolean().default(false),
  config: configRecord,
  credentials: z.record(z.string(), z.string().max(500)).default({}),
});

export type SaveInput = z.infer<typeof saveSchema>;

export const accountActionSchema = z.object({
  businessId: uuid,
  accountId: uuid,
});

export const enabledSchema = accountActionSchema.extend({ enabled: z.boolean() });

export const jobRetrySchema = z.object({
  businessId: uuid,
  jobId: uuid,
});

export const printTestSchema = accountActionSchema;

export const agentRegisterSchema = z.object({
  businessId: uuid,
  outletId: uuid,
  name: z
    .string()
    .trim()
    .min(1, "Name the agent (up to 60 characters).")
    .max(60, "Name the agent (up to 60 characters)."),
});

export const agentRevokeSchema = z.object({
  businessId: uuid,
  agentId: uuid,
});

/** Checks a save request beyond the shape: provider rules, settings keys, credential names. */
export function validateSave(input: SaveInput): string | null {
  const def = findProvider(input.provider);
  if (!def) return "Choose an integration.";
  if (def.fileExport)
    return "This is a file export. Download the CSV from the accounting section instead.";

  if (input.mode === "live" && !def.liveAvailable) {
    return def.key === "swiggy" || def.key === "zomato"
      ? "Live access for this provider needs partner onboarding. Use DEMO mode."
      : "Live connection is not available for this integration in this build. Use DEMO mode.";
  }

  if (input.provider === "printer" && !input.outletId) {
    return "Choose the outlet this printer serves.";
  }

  for (const [key, value] of Object.entries(input.config)) {
    const error = configValueError(input.provider, key, value);
    if (error) return error;
    if (!CONFIG_KEY_RE.test(key)) return "A setting name is not valid.";
  }

  const allowed = new Set(def.credentialFields.map((f) => f.name));
  for (const key of Object.keys(input.credentials)) {
    if (!allowed.has(key)) return "A credential field is not valid for this integration.";
  }
  return null;
}

/** A message the print test can carry. Kept short so it fits the printer's payload limit. */
export const PRINT_TEST_LINES = [
  "RestroNex printer test",
  "If you can read this, the printer works.",
] as const;

export const PRINT_LIMITS = { lines: MAX_LINES, chars: MAX_LINE_CHARS } as const;

export const PROVIDER_LABELS = Object.fromEntries(
  PROVIDER_CATALOG.map((p) => [p.key, p.label]),
) as Record<ProviderKey, string>;
