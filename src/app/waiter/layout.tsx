import type { ReactNode } from "react";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/env";
import { guardRedirect } from "@/lib/guarded-redirect";

/**
 * Phase 12 — waiter app shell. Sits outside the desktop (app) shell so the
 * touch layout gets the full screen. Sessions are verified per request here,
 * and every page and action re-checks orders.manage for its outlet.
 */

function isSupabaseConfigured(): boolean {
  try {
    getSupabaseEnv();
    return true;
  } catch {
    return false;
  }
}

export default async function WaiterLayout({ children }: { children: ReactNode }) {
  await connection();

  if (!isSupabaseConfigured()) {
    return await guardRedirect("/");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return await guardRedirect("/login");
  }

  return <div className="min-h-dvh bg-background text-foreground">{children}</div>;
}
