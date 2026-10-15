import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { guardRedirect } from "@/lib/guarded-redirect";
import { getManagedBusinesses } from "@/modules/business/queries";
import { OrderingSettingsForm } from "@/modules/online/components/ordering-settings-form";
import { QrPanel } from "@/modules/online/components/qr-panel";
import {
  loadActiveTables,
  loadOrderingSettings,
  loadQrCodes,
  loadStorefrontSlugs,
} from "@/modules/online/staff-service";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { loadPosOutlets } from "@/modules/orders/queries";

/**
 * Phase 17 — ordering settings and table QR codes. Requires settings.manage to
 * view (QR codes are management data). Staff with orders.view only use /orders/online.
 */

export const metadata: Metadata = { title: "Ordering settings" };

export default async function OrderingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
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
  if (!target)
    return <OrdersBusinessPicker businesses={manageable} basePath="/settings/ordering" />;

  const abilities = await getViewerAbilities(target.id);
  if (!abilities.can("settings.manage") || !abilities.userId) {
    return (
      <Card>
        <CardContent className="text-muted-foreground p-6 text-sm">
          Only owners and managers can change ordering settings.
        </CardContent>
      </Card>
    );
  }
  const membership = await findActiveMembership(abilities.userId, target.id);
  if (!membership) return await guardRedirect("/settings");

  const outlets = await loadPosOutlets(target.id, membership.role, membership.id);
  const outletId = outlets.find((o) => o.id === params.outlet)?.id ?? outlets[0]?.id;
  if (!outletId) return <p className="text-muted-foreground text-sm">No outlet is set up yet.</p>;

  // Permission is checked above; these reads use the service client.
  const [settings, tables, codes, slugs] = await Promise.all([
    loadOrderingSettings(outletId),
    loadActiveTables(outletId),
    loadQrCodes(outletId),
    loadStorefrontSlugs(target.id, outletId),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/settings" className="text-muted-foreground hover:text-ink text-sm">
          ← Back to settings
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Online ordering</h1>
        <p className="text-muted-foreground">
          {target.name} · {outlets.find((o) => o.id === outletId)?.name}
        </p>
        {slugs ? (
          <p className="text-sm">
            Website link:{" "}
            <Link
              href={`/order/${slugs.businessSlug}/${slugs.outletSlug}`}
              className="underline underline-offset-4"
            >
              /order/{slugs.businessSlug}/{slugs.outletSlug}
            </Link>
          </p>
        ) : null}
        {outlets.length > 1 ? (
          <nav aria-label="Outlets" className="flex flex-wrap gap-2 pt-2 text-sm">
            {outlets.map((o) => (
              <Link
                key={o.id}
                href={`/settings/ordering?business=${target.id}&outlet=${o.id}`}
                className={
                  o.id === outletId
                    ? "font-medium underline underline-offset-4"
                    : "text-muted-foreground hover:text-ink"
                }
              >
                {o.name}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>

      <OrderingSettingsForm
        businessId={target.id}
        outletId={outletId}
        initial={settings}
        canManage
      />
      <QrPanel
        businessId={target.id}
        outletId={outletId}
        tables={tables}
        codes={codes}
        canManage
        restaurantName={target.name}
      />
    </div>
  );
}
