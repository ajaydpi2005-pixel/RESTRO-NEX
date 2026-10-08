import type { ReactNode } from "react";
import { connection } from "next/server";
import { AppShell } from "@/components/layout/app-shell";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/env";
import { guardRedirect } from "@/lib/guarded-redirect";

/**
 * All (app) routes are authenticated — sessions are verified per request in
 * this layout, so the tree must never be statically prerendered.
 * `await connection()` opts every route into request-time rendering (see
 * next.config.ts for why Cache Components are disabled project-wide).
 */

function isSupabaseConfigured(): boolean {
  try {
    getSupabaseEnv();
    return true;
  } catch {
    return false;
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Force request-time rendering for every (app) route — see header comment.
  await connection();

  if (!isSupabaseConfigured()) {
    // No Supabase configured → nothing to authenticate against. The home
    // page shows setup guidance instead of a broken app shell.
    return await guardRedirect("/");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return await guardRedirect("/login");
  }

  return <AppShell userEmail={user.email ?? ""}>{children}</AppShell>;
}
