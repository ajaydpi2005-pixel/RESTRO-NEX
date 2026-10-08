import type { ReactNode } from "react";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/env";
import { guardRedirect } from "@/lib/guarded-redirect";

/**
 * Phase 6 — Onboarding is an immersive full-screen wizard (no app shell nav):
 * one task at a time until the restaurant is set up.
 */

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  await connection();
  try {
    getSupabaseEnv();
  } catch {
    return await guardRedirect("/");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return await guardRedirect("/login?next=/onboarding");
  }

  return <>{children}</>;
}
