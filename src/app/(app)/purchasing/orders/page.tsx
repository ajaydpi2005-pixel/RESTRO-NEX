import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { OutletTabs } from "@/modules/inventory/components/inventory-chrome";
import {
  PurchasingBusinessPicker,
  PurchasingDenied,
  PurchasingNav,
  PurchasingNoOutlet,
  StatusBadge,
} from "@/modules/purchasing/components/purchasing-chrome";
import { loadPurchaseOrders } from "@/modules/purchasing/queries";
import { paiseToDisplay } from "@/modules/purchasing/money";

export const metadata: Metadata = { title: "Purchase orders" };

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params, "purchasing.view");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <PurchasingBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <PurchasingDenied />;
  if (ctx.kind === "no-outlet") return <PurchasingNoOutlet />;

  const { business, abilities, outlets, outlet } = ctx;
  const canManage = abilities.can("purchasing.manage");
  const orders = await loadPurchaseOrders(business.id, outlet.id);
  const scope = `business=${business.id}&outlet=${outlet.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Orders &amp; receiving</h1>
          <p className="text-muted-foreground">
            {business.name} · {outlet.name}. Purchase history for this outlet, newest first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <OutletTabs businessId={business.id} outlets={outlets} activeId={outlet.id} path="/purchasing/orders" />
          {canManage ? (
            <Button asChild><Link href={`/purchasing/orders/new?${scope}`}>New purchase order</Link></Button>
          ) : null}
        </div>
      </div>

      <PurchasingNav businessId={business.id} outletId={outlet.id} />

      <Card>
        <CardHeader>
          <CardTitle>Purchase orders</CardTitle>
          <CardDescription>Stock is added only when a delivery is received against an order.</CardDescription>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No purchase orders at this outlet yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Order</th>
                    <th className="py-2 font-medium">Supplier</th>
                    <th className="py-2 font-medium">Created</th>
                    <th className="py-2 font-medium">Lines in full</th>
                    <th className="py-2 text-right font-medium">Subtotal</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="border-t">
                      <td className="py-2">
                        <Link
                          className="font-medium underline-offset-4 hover:underline"
                          href={`/purchasing/orders/${o.id}?${scope}`}
                        >
                          PO-{o.number}
                        </Link>
                      </td>
                      <td className="py-2">{o.supplierName}</td>
                      <td className="py-2 text-muted-foreground">{o.createdAt.slice(0, 10)}</td>
                      <td className="py-2 tabular-nums">
                        {o.linesComplete} / {o.lines}
                      </td>
                      <td className="py-2 text-right tabular-nums">₹{paiseToDisplay(o.subtotalMinor)}</td>
                      <td className="py-2">
                        <StatusBadge status={o.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
