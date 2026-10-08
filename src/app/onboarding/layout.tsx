import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/env";

/**
 * Phase 6 — Onboarding is an immersive full-screen wizard (no app shell nav):
 * one task at a time until the restaurant is set up.
 */
export const instant = false;

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  try {
    getSupabaseEnv();
  } catch {
    redirect("/");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/onboarding");
  }

  return <>{children}</>;
}
