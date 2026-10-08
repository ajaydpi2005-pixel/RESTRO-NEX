import { z } from "zod";

/**
 * Environment variable contract for RestroNex.
 *
 * Phase 1: Supabase variables become REQUIRED for any code path that touches
 * the database — getSupabaseEnv()/getSupabaseServiceEnv() throw loud,
 * actionable errors. Parsing stays lazy so `next build` and unrelated pages
 * never fail because a secret is absent.
 *
 * Rules:
 * - NEXT_PUBLIC_* may reach the browser. Everything else must stay server-side.
 * - The service-role key MUST NEVER be imported from client code.
 */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** Public base URL of the deployment. */
  NEXT_PUBLIC_APP_URL: z.string().min(1).optional(),

  /** Supabase project (Dashboard → Project Settings → API). */
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  /** Server-only. BYPASSRLS — never expose to the client. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  /** Phase 20 — payment provider (Razorpay or equivalent). */
  PAYMENT_KEY_ID: z.string().min(1).optional(),
  PAYMENT_KEY_SECRET: z.string().min(1).optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedEnv: ServerEnv | undefined;

/** Parse and cache the server environment (lazy — never runs at build time). */
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

/** Supabase project credentials for user-facing (RLS-enforced) clients. */
export function getSupabaseEnv(): { url: string; anonKey: string } {
  const env = getServerEnv();
  return {
    url: requireEnv(env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    anonKey: requireEnv(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  };
}

/**
 * Service-role credentials for privileged server flows only (onboarding,
 * admin tooling). Calling this from client code is a security violation.
 */
export function getSupabaseServiceEnv(): { url: string; serviceRoleKey: string } {
  if (typeof window !== "undefined") {
    throw new Error("[RestroNex] Service-role credentials may only be used server-side.");
  }
  const env = getServerEnv();
  return {
    url: requireEnv(env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    serviceRoleKey: requireEnv(
      env.SUPABASE_SERVICE_ROLE_KEY,
      "SUPABASE_SERVICE_ROLE_KEY",
    ),
  };
}
