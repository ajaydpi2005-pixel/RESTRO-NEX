import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Mail, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { ChangePasswordForm } from "@/modules/auth/components/change-password-form";
import { ProfileForm } from "@/modules/auth/components/profile-form";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("full_name, phone, email")
    .eq("id", user.id)
    .maybeSingle();

  const emailVerified = user.email_confirmed_at != null;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Account</h1>
        <p className="text-muted-foreground">Your profile and security settings.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sign-in details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Mail className="size-4 text-gold-deep dark:text-gold" />
            {user.email}
          </span>
          <Badge
            variant={emailVerified ? "secondary" : "outline"}
            className={emailVerified ? "" : "border-gold/50"}
          >
            <ShieldCheck className="size-3.5" />
            {emailVerified ? "Email verified" : "Email not verified"}
          </Badge>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile</CardTitle>
            <CardDescription>How your name appears across RestroNex.</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileForm
              initialFullName={profile?.full_name ?? ""}
              initialPhone={profile?.phone ?? ""}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Password</CardTitle>
            <CardDescription>
              Changing your password requires your current one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
