import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, PartyPopper, Rocket, Store, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getOnboardingContext } from "@/modules/onboarding/queries";
import { completionPercent } from "@/modules/onboarding/steps";

import { siteConfig } from "@/config/site";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Authenticated home base. Sales and operations panels appear as the modules
 * ship; until then this page reflects the true state of the account — no
 * sample data. Phase 6: first-time users go straight into onboarding, and
 * owners with unfinished setup get a resume banner.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ onboarded?: string; joined?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const params = await searchParams;
  const admin = createAdminClient();

  // Any membership at all? Brand-new accounts start with onboarding.
  const { count: membershipCount } = await admin
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user?.id ?? "")
    .eq("status", "active");

  if ((membershipCount ?? 0) === 0) {
    redirect("/onboarding");
  }

  const onboarding = await getOnboardingContext();
  const resumeBusiness =
    onboarding.business && onboarding.progress && !onboarding.progress.completedAt
      ? onboarding.business
      : null;
  const resumePercent = onboarding.progress
    ? completionPercent(onboarding.progress.completedSteps)
    : 0;

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
          Phase {siteConfig.buildPhase + 4} · Onboarding live
        </Badge>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Welcome back, {displayName}
        </h1>
        <p className="text-muted-foreground">
          Your account is verified and signed in. The full operations dashboard — today&apos;s
          sales, orders, top products, outlet performance — lights up as each module ships.
        </p>
      </div>

      {params.onboarded === "1" ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-gold/50 bg-gold/10 p-4 text-sm"
        >
          <PartyPopper className="mt-0.5 size-4.5 shrink-0 text-gold-deep" aria-hidden />
          <span>
            <strong className="font-semibold">Setup complete.</strong> Your restaurant is ready —
            manage outlets, menus and staff from Settings, and watch this dashboard fill up as
            orders start flowing.
          </span>
        </div>
      ) : null}

      {params.joined === "1" ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-gold/50 bg-gold/10 p-4 text-sm"
        >
          <PartyPopper className="mt-0.5 size-4.5 shrink-0 text-gold-deep" aria-hidden />
          <span>
            <strong className="font-semibold">Invitation accepted.</strong> You&apos;re now part of
            the team — your role and outlets are set by the restaurant owner.
          </span>
        </div>
      ) : null}

      {resumeBusiness ? (
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-ink/15 bg-ink p-4 text-cream">
          <Rocket className="size-5 shrink-0 text-gold" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Finish setting up {resumeBusiness.name}</p>
            <p className="text-xs text-cream/70">
              You&apos;re {resumePercent}% through onboarding — pick up right where you left off.
            </p>
          </div>
          <Button variant="outline" className="border-gold/60 bg-transparent text-gold hover:bg-gold/10 hover:text-gold-bright" asChild>
            <Link href="/onboarding">
              Resume setup <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      ) : null}

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
                : "No businesses yet — set up your restaurant to get started."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Manage business profile, outlets, tables, menus and staff from Settings. The guided
              onboarding flow stays available any time from the banner above.
            </p>
            <Button variant="outline" className="w-fit" asChild>
              <Link href="/settings/business">
                {businessCount && businessCount > 0 ? "Manage businesses" : "Set up your restaurant"}{" "}
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
