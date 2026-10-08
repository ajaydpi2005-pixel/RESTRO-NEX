import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { resolveOrdersBusiness } from "@/modules/orders/context";
import { loadPosOutlets } from "@/modules/orders/queries";
import { FloorMap } from "@/modules/floors/components/floor-map";
import { FloorManager } from "@/modules/floors/components/floor-manager";
import {
  loadActiveDineInOrders,
  loadActiveOrderItems,
  loadFloorPlan,
  loadFreeTables,
} from "@/modules/floors/queries";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Floor" };

export default async function FloorPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const { withOrdersView, business } = await resolveOrdersBusiness(params.business);
  if (withOrdersView.length === 0) return await guardRedirect("/settings");
  if (!business) return <OrdersBusinessPicker businesses={withOrdersView} basePath="/floor" />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("orders.view")) {
    return (
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Floor</h1>
        <p className="text-muted-foreground">
          You don&apos;t have permission to view the floor in this business.
        </p>
      </div>
    );
  }

  const membership = abilities.userId
    ? await findActiveMembership(abilities.userId, business.id)
    : null;
  if (!membership) return await guardRedirect("/settings");

  const outlets = await loadPosOutlets(business.id, membership.role, membership.id);
  if (outlets.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Floor</h1>
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-medium">No outlet assigned</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask an owner or admin to add an outlet and assign you to it.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
  const outlet = outlets.find((o) => o.id === params.outlet) ?? outlets[0]!;

  const [plan, freeTables, activeOrders, orderItems] = await Promise.all([
    loadFloorPlan(outlet.id),
    loadFreeTables(outlet.id),
    loadActiveDineInOrders(outlet.id),
    loadActiveOrderItems(outlet.id),
  ]);

  const canManage = abilities.can("orders.manage");
  const canConfigure = abilities.can("outlets.manage");
  const queryBase = `/floor?business=${business.id}&outlet=${outlet.id}`;
  const posBase = `/pos?business=${business.id}&outlet=${outlet.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Floor</h1>
          <p className="text-sm text-muted-foreground">
            {business.name} · {outlet.name}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {outlets.length > 1 ? (
            <>
              <span className="text-muted-foreground">Outlet:</span>
              <div className="flex flex-wrap gap-1">
                {outlets.map((o) => (
                  <Link
                    key={o.id}
                    href={`/floor?business=${business.id}&outlet=${o.id}`}
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
            </>
          ) : null}
        </div>
      </div>

      <FloorMap
        businessId={business.id}
        outletId={outlet.id}
        queryBase={queryBase}
        posBase={posBase}
        plan={plan}
        freeTables={freeTables}
        activeOrders={activeOrders}
        orderItems={orderItems}
        canManage={canManage}
      />

      {canConfigure ? (
        <div className="space-y-3">
          <div>
            <h2 className="font-display text-xl font-semibold tracking-tight">Manage layout</h2>
            <p className="text-sm text-muted-foreground">
              Floors, sections and tables for {outlet.name}. Occupied or reserved tables stay protected.
            </p>
          </div>
          <FloorManager businessId={business.id} outletId={outlet.id} plan={plan} />
        </div>
      ) : null}
    </div>
  );
}
