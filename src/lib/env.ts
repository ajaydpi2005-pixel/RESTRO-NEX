import { z } from "zod";

/**
 * Environment variable contract for RestroNex.
 *
 * Phase 0 scaffolding: all values are optional so the app builds and runs
 * before external services exist. Each phase tightens the schema for the
 * services it introduces. Server-only secrets must never be prefixed with
 * NEXT_PUBLIC_.
 */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** Public base URL of the deployment. */
  NEXT_PUBLIC_APP_URL: z.string().min(1).optional(),

  /** Phase 1 — Supabase project credentials. */
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  /** Server-only. Full database access — never expose to the client. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  /** Phase 20 — payment provider (Razorpay or equivalent). */
  PAYMENT_KEY_ID: z.string().min(1).optional(),
  PAYMENT_KEY_SECRET: z.string().min(1).optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedEnv: ServerEnv | undefined;

/**
 * Parse and cache the server environment. Lazy so missing variables never
 * break build time — phases that require a variable call requireEnv().
 */
export function getServerEnv(): ServerEnv {
  if (!cachedEnv) {
    cachedEnv = serverEnvSchema.parse(process.env);
  }
  return cachedEnv;
}

/** Assert an optional env value is present; throw a helpful error otherwise. */
export function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `[RestroNex] Missing required environment variable: ${name}. See .env.example.`,
    );
  }
  return value;
}
