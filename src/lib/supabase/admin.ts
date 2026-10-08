import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceEnv } from "@/lib/env";

/**
 * Supabase client with the SERVICE ROLE key (BYPASSRLS).
 *
 * SERVER ONLY. For privileged flows such as onboarding, webhooks and Super
 * Admin tooling where server-side permission checks have already passed.
 * Never expose the returned client or its key to client code, and never use
 * it as a shortcut around permission checks.
 */
export function createAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("[RestroNex] The admin client is server-only.");
  }

  const { url, serviceRoleKey } = getSupabaseServiceEnv();

  return createSupabaseClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
