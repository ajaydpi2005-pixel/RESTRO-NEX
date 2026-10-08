import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ROLE_META, isRole } from "@/lib/rbac/permissions";
import { AcceptInviteForm } from "@/modules/onboarding/components/accept-invite-form";
import { connection } from "next/server";

export const metadata: Metadata = { title: "Join a restaurant" };

/** Wall-clock check kept out of render scope (React purity rules). */
function isPastIso(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

/**
 * Phase 6 — Staff invitation acceptance.
 *
 * The token is looked up server-side; nothing about the invite is trusted
 * from the client. Acceptance itself runs through accept_staff_invite(),
 * which re-validates everything atomically.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const admin = createAdminClient();

  const { data: invite } = await admin
    .from("staff_invites")
    .select("id, business_id, email, role, outlet_ids, expires_at, accepted_at, revoked_at")
    .eq("token", token)
    .maybeSingle();

  const { data: business } = invite
    ? await admin.from("businesses").select("name").eq("id", invite.business_id).maybeSingle()
    : { data: null };

  let outletNames: string[] = [];
  if (invite && Array.isArray(invite.outlet_ids) && invite.outlet_ids.length > 0) {
    const { data: outlets } = await admin
      .from("outlets")
      .select("id, name")
      .in("id", invite.outlet_ids as string[]);
    outletNames = (outlets ?? []).map((outlet) => outlet.name);
  }

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-dvh items-center justify-center bg-cream px-5 py-12 text-ink">
      <div className="w-full max-w-md space-y-6">
        <p className="text-center font-display text-2xl font-semibold tracking-tight">
          Restro<span className="text-gold">Nex</span>
        </p>
        {children}
      </div>
    </div>
  );

  const invalidCard = (title: string, message: string) =>
    shell(
      <Card>
        <CardHeader>
          <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
            <ShieldX className="size-4.5" aria-hidden />
          </div>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link href="/">Back to RestroNex</Link>
          </Button>
        </CardContent>
      </Card>,
    );

  if (!invite) return invalidCard("Invitation not found", "This invitation link is invalid. Ask the restaurant owner for a fresh link.");
  if (invite.revoked_at) return invalidCard("Invitation revoked", "This invitation was revoked by the restaurant. Ask the owner for a new one.");
  if (invite.accepted_at) return invalidCard("Already used", "This invitation has already been accepted.");
  if (isPastIso(invite.expires_at)) {
    return invalidCard("Invitation expired", "This invitation has expired. Ask the restaurant owner for a fresh link.");
  }

  const roleLabel = isRole(invite.role) ? ROLE_META[invite.role].label : invite.role;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return shell(
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Join {business?.name ?? "a restaurant"}</CardTitle>
          <CardDescription>
            You&apos;ve been invited as <strong className="text-ink">{roleLabel}</strong>
            {outletNames.length > 0 ? ` at ${outletNames.join(", ")}` : ""}. Sign in — or create an
            account — to accept.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button className="w-full" asChild>
            <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to accept</Link>
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            No account yet?{" "}
            <Link href="/signup" className="underline underline-offset-4 hover:text-ink">
              Create one
            </Link>{" "}
            first, then return to this link.
          </p>
        </CardContent>
      </Card>,
    );
  }

  return shell(
    <Card>
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
          <CheckCircle2 className="size-4.5" aria-hidden />
        </div>
        <CardTitle className="text-lg">Join {business?.name ?? "this restaurant"}</CardTitle>
        <CardDescription>
          Role: <strong className="text-ink">{roleLabel}</strong>
          {outletNames.length > 0 ? <> · Outlets: {outletNames.join(", ")}</> : " · All outlets"}
          {invite.email ? <> · Issued for {invite.email}</> : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">Signed in as {user.email}</p>
        <AcceptInviteForm token={token} />
        <p className="text-xs text-muted-foreground">
          Accepting adds this restaurant to your RestroNex workspace with the role above.
        </p>
      </CardContent>
    </Card>,
  );
}
