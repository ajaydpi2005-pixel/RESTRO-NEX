import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/env";

/**
 * All (app) routes are authenticated — sessions are verified per request in
 * this layout, so the tree must never be statically prerendered. With Cache
 * Components enabled, `instant = false` marks these routes as blocking.
 */
export const instant = false;

function isSupabaseConfigured(): boolean {
  try {
    getSupabaseEnv();
    return true;
  } catch {
    return false;
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!isSupabaseConfigured()) {
    // No Supabase configured → nothing to authenticate against. The home
    // page shows setup guidance instead of a broken app shell.
    redirect("/");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <AppShell userEmail={user.email ?? ""}>{children}</AppShell>;
}
