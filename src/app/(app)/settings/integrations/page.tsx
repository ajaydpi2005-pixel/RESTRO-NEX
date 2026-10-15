import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { guardRedirect } from "@/lib/guarded-redirect";
import { getManagedBusinesses } from "@/modules/business/queries";
import { IntegrationsPanel } from "@/modules/integrations/components/integrations-panel";
import { loadIntegrationPanel } from "@/modules/integrations/queries";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { loadPosOutlets } from "@/modules/orders/queries";

/**
 * Phase 18 — integrations. Owners and managers only (settings.manage). Every integration
 * is DEMO in this build: the panel says so, and live connections are not offered.
 */

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage({
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
    return <OrdersBusinessPicker businesses={manageable} basePath="/settings/integrations" />;
  }

  const abilities = await getViewerAbilities(target.id);
  if (!abilities.can("settings.manage") || !abilities.userId) {
    return (
      <Card>
        <CardContent className="text-muted-foreground p-6 text-sm">
          Only owners and managers can manage integrations.
        </CardContent>
      </Card>
    );
  }
  const membership = await findActiveMembership(abilities.userId, target.id);
  if (!membership) return await guardRedirect("/settings");

  const outlets = await loadPosOutlets(target.id, membership.role, membership.id);
  const panel = await loadIntegrationPanel(abilities.userId, target.id);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/settings" className="text-muted-foreground hover:text-ink text-sm">
          ← Back to settings
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-muted-foreground">
          {target.name}. Connections run in DEMO mode in this build: nothing is sent to a provider.
        </p>
      </div>
      <IntegrationsPanel
        businessId={target.id}
        outlets={outlets.map((o) => ({ id: o.id, name: o.name }))}
        panel={panel}
      />
    </div>
  );
}
