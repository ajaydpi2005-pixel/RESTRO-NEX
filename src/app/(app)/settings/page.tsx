import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Building2, LifeBuoy, Store, Users } from "lucide-react";
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

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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

        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
              <Store className="size-4.5" />
            </div>
            <CardTitle className="text-base">Online ordering</CardTitle>
            <CardDescription>
              Website and table QR ordering, minimum order, fees and table QR codes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/settings/ordering"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-gold-deep underline-offset-4 hover:underline dark:text-gold"
            >
              Manage ordering <ArrowRight className="size-4" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
              <Store className="size-4.5" />
            </div>
            <CardTitle className="text-base">Integrations</CardTitle>
            <CardDescription>
              Printers, messaging, payments and accounting exports. Connections run in DEMO mode in
              this build.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/settings/integrations"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-gold-deep underline-offset-4 hover:underline dark:text-gold"
            >
              Manage integrations <ArrowRight className="size-4" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
              <LifeBuoy className="size-4.5" />
            </div>
            <CardTitle className="text-base">Support</CardTitle>
            <CardDescription>
              Open a ticket with RestroNex support and follow the replies for your business.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/settings/support"
              className="text-gold-deep dark:text-gold inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline"
            >
              Open support <ArrowRight className="size-4" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
              <Users className="size-4.5" />
            </div>
            <CardTitle className="text-base">Staff &amp; roles</CardTitle>
            <CardDescription>
              Assign roles, outlets and permissions. Enforced server-side on every operation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/settings/staff"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-gold-deep underline-offset-4 hover:underline dark:text-gold"
            >
              Manage staff <ArrowRight className="size-4" />
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
