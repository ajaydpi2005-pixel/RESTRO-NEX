import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Store, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

import { siteConfig } from "@/config/site";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Phase 3 dashboard: authenticated home base. Sales and operations panels
 * appear once restaurants exist (onboarding ships in Phase 6). Until then
 * this page reflects the true state of the account — no sample data.
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("full_name")
    .eq("id", user?.id ?? "")
    .maybeSingle();

  const { count: businessCount } = await supabase
    .from("businesses")
    .select("id", { count: "exact", head: true });

  const { count: outletCount } = await supabase
    .from("outlets")
    .select("id", { count: "exact", head: true });

  const displayName = profile?.full_name || user?.email || "there";

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Badge variant="outline" className="w-fit border-gold/50 text-muted-foreground">
          Phase {siteConfig.buildPhase + 4} · Business management live
        </Badge>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Welcome back, {displayName}
        </h1>
        <p className="text-muted-foreground">
          Your account is verified and signed in. The full operations dashboard — today&apos;s
          sales, orders, top products, outlet performance — lights up once your first restaurant
          is onboarded.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
              <Store className="size-4.5" />
            </div>
            <CardTitle className="text-base">Your restaurants</CardTitle>
            <CardDescription>
              {businessCount && businessCount > 0
                ? `${businessCount} business${businessCount === 1 ? "" : "es"} · ${outletCount ?? 0} outlet${(outletCount ?? 0) === 1 ? "" : "s"} on this account.`
                : "No businesses yet — create your business to start adding outlets."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Manage business profile, outlets, order types and operating hours from Settings.
              Full guided onboarding — tables, kitchen stations, menu and staff — arrives in
              Phase 6.
            </p>
            <Button variant="outline" className="w-fit" asChild>
              <Link href="/settings/business">
                {businessCount && businessCount > 0 ? "Manage businesses" : "Create your business"}{" "}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
              <UserRound className="size-4.5" />
            </div>
            <CardTitle className="text-base">Your account</CardTitle>
            <CardDescription>Signed in as {user?.email}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Manage your profile, phone number and password from the account page. Sessions are
              handled by Supabase Auth with secure httpOnly cookies.
            </p>
            <Button variant="outline" className="w-fit" asChild>
              <Link href="/account">
                Manage account <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
