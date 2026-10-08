import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client for the BROWSER.
 *
 * Runs with the anon key only — every query is filtered by PostgreSQL Row
 * Level Security for the signed-in user. NEXT_PUBLIC_ values are read with
 * static property access so Next.js inlines them at build time.
 */
export function createClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "[RestroNex] Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local (see docs/SUPABASE_SETUP.md).",
    );
  }

  return createBrowserClient(url, anonKey);
}
