import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { LogoMark } from "@/components/brand/logo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OperatorSignInForm } from "@/modules/admin/components/operator-sign-in-form";
import { getOperatorState } from "@/modules/admin/session";

export const metadata: Metadata = {
  title: "Super Admin sign-in",
  robots: { index: false, follow: false },
};

/**
 * Operator sign-in. Only accounts listed as operators get through; restaurant
 * accounts are signed out again here (see auth-actions.ts).
 */
export default async function AdminSignInPage() {
  await connection();
  const state = await getOperatorState();
  if (state.kind === "operator") redirect("/admin");

  return (
    <div className="bg-ink text-parchment flex min-h-dvh items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-3">
          <span className="inline-flex items-center gap-2.5">
            <LogoMark />
            <span className="text-foreground text-sm font-semibold">RestroNex Super Admin</span>
          </span>
          <CardTitle className="font-display text-xl">Operator sign-in</CardTitle>
          <CardDescription>
            For RestroNex operators only. Restaurant accounts cannot use this page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OperatorSignInForm />
        </CardContent>
      </Card>
    </div>
  );
}
