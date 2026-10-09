import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { resolveKitchenBusiness } from "@/modules/kitchen/context";
import { KitchenBoard } from "@/modules/kitchen/components/kitchen-board";
import { loadBoardSnapshot } from "@/modules/kitchen/queries";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { loadPosOutlets } from "@/modules/orders/queries";

export const metadata: Metadata = { title: "Kitchen Display" };

/**
 * Phase 11 — Kitchen Display System. Server-rendered snapshot of the live
 * board; the client keeps it current over Supabase Realtime.
 */
export default async function KitchenPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const { eligible, business } = await resolveKitchenBusiness(params.business, "kitchen.view");
  if (eligible.length === 0) return await guardRedirect("/settings");
  if (!business) return <OrdersBusinessPicker businesses={eligible} basePath="/kitchen" />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("kitchen.view")) {
    return (
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Kitchen Display</h1>
        <p className="text-muted-foreground">You don&apos;t have permission to view the kitchen in this business.</p>
      </div>
    );
  }

  const membership = abilities.userId ? await findActiveMembership(abilities.userId, business.id) : null;
  if (!membership) return await guardRedirect("/settings");

  const outlets = await loadPosOutlets(business.id, membership.role, membership.id);
  if (outlets.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Kitchen Display</h1>
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-medium">No outlet assigned</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask an owner or admin to assign you to an outlet&apos;s kitchen.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
  const outlet = outlets.find((o) => o.id === params.outlet) ?? outlets[0]!;
  const snapshot = await loadBoardSnapshot(outlet.id);

  const query = `business=${business.id}&outlet=${outlet.id}`;
  return (
    <div className="space-y-4">
      {outlets.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Outlet:</span>
          {outlets.map((o) => (
            <Link
              key={o.id}
              href={`/kitchen?business=${business.id}&outlet=${o.id}`}
              className={
                o.id === outlet.id
                  ? "rounded-full bg-ink px-3 py-1 font-medium text-parchment"
                  : "rounded-full border border-border px-3 py-1 text-muted-foreground hover:text-ink"
              }
            >
              {o.name}
            </Link>
          ))}
        </div>
      ) : null}

      <KitchenBoard
        outletId={outlet.id}
        outletName={outlet.name}
        initialItems={snapshot.items}
        initialEvents={snapshot.events}
        initialStations={snapshot.stations}
        canOperate={abilities.can("kitchen.operate")}
        canManage={abilities.can("kitchen.manage")}
        routingHref={`/kitchen/routing?${query}`}
      />
    </div>
  );
}
