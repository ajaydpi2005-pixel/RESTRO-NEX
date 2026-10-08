import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Create your RestroNex account and onboard your restaurant.",
};

const onboardingSteps = [
  "Create your business",
  "Select your restaurant type",
  "Create your first outlet",
  "Configure tax, tables and kitchen",
  "Build your menu",
  "Invite staff and choose a plan",
];

export default function SignupPage() {
  return (
    <Card>
      <CardHeader>
        <Badge variant="outline" className="mb-2 w-fit border-gold/50">
          Phase 3 — Authentication
        </Badge>
        <CardTitle className="text-xl">Create your RestroNex account</CardTitle>
        <CardDescription>
          Account creation opens when authentication ships. Sign-up is deliberately not a stubbed
          form — it will be a real, verified flow.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2">
          {onboardingSteps.map((step) => (
            <li key={step} className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <Check className="size-4 shrink-0 text-gold-deep dark:text-gold" />
              {step}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Includes email verification, password recovery and resumable onboarding. Super Admin
          access is never granted through public sign-up.
        </p>
        <div className="flex flex-col gap-2">
          <Button asChild>
            <Link href="/login">Already have an account? Log in</Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link href="/">Back to home</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
