import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Log in",
  description: "Sign in to your RestroNex restaurant workspace.",
};

export default function LoginPage() {
  return (
    <Card>
      <CardHeader>
        <Badge variant="outline" className="mb-2 w-fit border-gold/50">
          Phase 3 — Authentication
        </Badge>
        <CardTitle className="text-xl">Log in to RestroNex</CardTitle>
        <CardDescription>
          This is the entry point to your restaurant workspace. Authentication has not been built
          yet — no accounts exist at this stage of the greenfield build.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When Phase 3 ships, this page provides email login, session management, password
          recovery and a path into business onboarding.
        </p>
        <div className="flex flex-col gap-2">
          <Button asChild>
            <Link href="/signup">Create an account instead</Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link href="/">Back to home</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
