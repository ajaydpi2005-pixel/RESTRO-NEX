import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";

/**
 * Supabase client for SERVER Components, Server Actions and Route Handlers.
 *
 * Uses the anon key plus the request's session cookies — queries are still
 * fully RLS-scoped to the signed-in user. Session refresh writes go through
 * Next.js cookies(); refreshes triggered from Server Components are ignored
 * (read-only context) and will be handled by auth middleware in Phase 3.
 */
export async function createClient(): Promise<SupabaseClient> {
  const { url, anonKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component — safe to ignore when session
          // refresh is owned by middleware (Phase 3).
        }
      },
    },
  });
}
