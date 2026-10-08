import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Building2, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getManagedBusinesses } from "@/modules/business/queries";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const businesses = await getManagedBusinesses();
  const owned = businesses.filter((b) => b.role === "owner");

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Badge variant="outline" className="w-fit border-gold/50 text-muted-foreground">
          Phase {siteConfig.buildPhase + 4} · Business management
        </Badge>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your business profile and outlets. Roles, staff and deeper preferences arrive
          with their phases.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
              <Building2 className="size-4.5" />
            </div>
            <CardTitle className="text-base">Business profile</CardTitle>
            <CardDescription>
              {owned.length > 0
                ? `You own ${owned.length} business${owned.length === 1 ? "" : "es"}.`
                : "Create the business that runs your restaurants."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/settings/business"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-gold-deep underline-offset-4 hover:underline dark:text-gold"
            >
              Manage businesses <ArrowRight className="size-4" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
              <Store className="size-4.5" />
            </div>
            <CardTitle className="text-base">Outlets</CardTitle>
            <CardDescription>
              Addresses, contact details, order types, operating hours and activation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/settings/outlets"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-gold-deep underline-offset-4 hover:underline dark:text-gold"
            >
              Manage outlets <ArrowRight className="size-4" />
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
