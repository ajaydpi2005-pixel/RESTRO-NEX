import type { Metadata } from "next";
import { SignInForm } from "@/modules/auth/components/sign-in-form";
import { sanitizeNext } from "@/modules/auth/schemas";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Log in",
  description: "Sign in to your RestroNex restaurant workspace.",
};

/** Reads `searchParams` (next/error) — blocking route, not a static shell. */
export const instant = false;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = sanitizeNext(params.next);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>Sign in to your RestroNex workspace.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {params.error ? (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            {params.error}
          </div>
        ) : null}
        <SignInForm next={next} />
      </CardContent>
    </Card>
  );
}
