import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { getManagedBusinesses } from "@/modules/business/queries";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { SupportPanel } from "@/modules/support/components/support-panel";
import { loadTenantSupportTickets } from "@/modules/support/queries";

/**
 * Tenant support. Owners and managers (settings.manage) can open tickets and
 * reply. The database enforces the same check on every write.
 */

export const metadata: Metadata = { title: "Support" };

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string }>;
}) {
  const params = await searchParams;
  const businesses = await getManagedBusinesses();
  const manageable = businesses.filter((b) => b.role === "owner" || b.role === "manager");
  if (manageable.length === 0) return await guardRedirect("/settings");

  const target = params.business
    ? manageable.find((b) => b.id === params.business)
    : manageable.length === 1
      ? manageable[0]
      : undefined;
  if (!target) {
    return <OrdersBusinessPicker businesses={manageable} basePath="/settings/support" />;
  }

  const abilities = await getViewerAbilities(target.id);
  if (!abilities.can("settings.manage")) {
    return (
      <Card>
        <CardContent className="text-muted-foreground p-6 text-sm">
          Only owners and managers can open support tickets for this business.
        </CardContent>
      </Card>
    );
  }

  const tickets = await loadTenantSupportTickets(target.id);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/settings" className="text-muted-foreground hover:text-ink text-sm">
          ← Back to settings
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Support</h1>
        <p className="text-muted-foreground">
          {target.name}. Replies from RestroNex support appear here.
        </p>
      </div>
      <SupportPanel businessId={target.id} tickets={tickets} />
    </div>
  );
}
