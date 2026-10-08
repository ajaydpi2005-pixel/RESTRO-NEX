import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { PosTerminal } from "@/modules/orders/components/pos-terminal";
import { resolveOrdersBusiness } from "@/modules/orders/context";
import {
  loadBusinessTaxPct,
  loadHeldOrders,
  loadOrderForPos,
  loadPosMenu,
  loadPosOutlets,
  loadPosTables,
} from "@/modules/orders/queries";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "POS" };

export default async function PosPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string; order?: string }>;
}) {
  const params = await searchParams;
  const { withOrdersView, business } = await resolveOrdersBusiness(params.business);
  if (withOrdersView.length === 0) return await guardRedirect("/settings");
  if (!business) return <OrdersBusinessPicker businesses={withOrdersView} basePath="/pos" />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("orders.view")) {
    return (
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">POS</h1>
        <p className="text-muted-foreground">You don&apos;t have permission to view the POS in this business.</p>
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
        <h1 className="font-display text-3xl font-semibold tracking-tight">POS</h1>
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

  const [menu, tables, held, businessTaxPct, resume] = await Promise.all([
    loadPosMenu(business.id, outlet.id),
    loadPosTables(outlet.id),
    loadHeldOrders(outlet.id),
    loadBusinessTaxPct(business.id),
    params.order ? loadOrderForPos(business.id, params.order) : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">POS</h1>
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
                    href={`/pos?business=${business.id}&outlet=${o.id}`}
                    className={
                      o.id === outlet.id
                        ? "rounded-md bg-ink px-2.5 py-1 font-medium text-parchment"
                        : "rounded-md border border-border px-2.5 py-1 text-muted-foreground hover:text-ink"
                    }
                  >
                    {o.name}
                  </Link>
                ))}
              </div>
            </>
          ) : null}
          <Link
            href={`/orders?business=${business.id}`}
            className="rounded-md border border-border px-2.5 py-1 text-muted-foreground hover:text-ink"
          >
            Orders
          </Link>
        </div>
      </div>

      <PosTerminal
        businessId={business.id}
        outletId={outlet.id}
        queryBase={`/pos?business=${business.id}&outlet=${outlet.id}`}
        categories={menu.categories}
        products={menu.products}
        combos={menu.combos}
        tables={tables}
        held={held}
        businessTaxPct={businessTaxPct}
        canManage={abilities.can("orders.manage")}
        canDiscount={abilities.can("discounts.apply")}
        resume={
          resume && params.order
            ? { orderId: params.order, ...resume }
            : null
        }
      />
    </div>
  );
}
