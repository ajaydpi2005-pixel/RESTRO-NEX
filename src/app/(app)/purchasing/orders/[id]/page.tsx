import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { loadIngredients } from "@/modules/inventory/queries";
import { roundQty, toBaseQty } from "@/modules/inventory/units";
import { OutletTabs } from "@/modules/inventory/components/inventory-chrome";
import { CancelOrderForm, SendOrderButton } from "@/modules/purchasing/components/po-actions";
import { ReceiveForm, type ReceiveLine } from "@/modules/purchasing/components/receive-form";
import {
  PurchasingBusinessPicker,
  PurchasingDenied,
  PurchasingNav,
  PurchasingNoOutlet,
  StatusBadge,
} from "@/modules/purchasing/components/purchasing-chrome";
import { loadPurchaseOrder } from "@/modules/purchasing/queries";
import { paiseToDisplay } from "@/modules/purchasing/money";

export const metadata: Metadata = { title: "Purchase order" };

export default async function PurchaseOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const ctx = await loadInventoryPageContext(query, "purchasing.view");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <PurchasingBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <PurchasingDenied />;
  if (ctx.kind === "no-outlet") return <PurchasingNoOutlet />;

  const { business, abilities, outlets, outlet } = ctx;
  const canManage = abilities.can("purchasing.manage");
  const detail = await loadPurchaseOrder(business.id, outlet.id, id);
  if (!detail) notFound();
  const { order, items, receipts } = detail;
  const ingredients = await loadIngredients(business.id);
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));

  const canReceive = canManage && (order.status === "sent" || order.status === "partially_received");
  const receiveLines: ReceiveLine[] = items
    .filter((i) => i.qtyReceivedBase < i.qtyOrderedBase)
    .map((i) => {
      const ing = ingredientById.get(i.ingredientId);
      const perUnit = ing ? toBaseQty(ing.unit, i.unit, 1) : 1;
      return {
        poItemId: i.id,
        ingredientName: i.ingredientName,
        ingredientUnit: ing?.unit ?? "",
        unit: i.unit,
        outstanding: roundQty((i.qtyOrderedBase - i.qtyReceivedBase) / perUnit),
      };
    });
  const scope = `business=${business.id}&outlet=${outlet.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            <Link className="underline-offset-4 hover:underline" href={`/purchasing/orders?${scope}`}>
              Orders
            </Link>{" "}
            / PO-{order.number}
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            PO-{order.number} · {order.supplierName}
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <StatusBadge status={order.status} /> Created {order.createdAt.slice(0, 10)}
            {order.expectedOn ? ` · expected ${order.expectedOn}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <OutletTabs businessId={business.id} outlets={outlets} activeId={outlet.id} path={`/purchasing/orders/${id}`} />
          {canManage && order.status === "draft" ? (
            <Button asChild variant="outline">
              <Link href={`/purchasing/orders/${id}/edit?${scope}`}>Edit draft</Link>
            </Button>
          ) : null}
        </div>
      </div>

      <PurchasingNav businessId={business.id} outletId={outlet.id} />

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
          <CardDescription>
            Ordered and received quantities are in the order unit. Subtotal <span className="font-medium">₹{paiseToDisplay(order.subtotalMinor)}</span>
            {order.notes ? ` · ${order.notes}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 font-medium">Ingredient</th>
                  <th className="py-2 text-right font-medium">Ordered</th>
                  <th className="py-2 text-right font-medium">Received</th>
                  <th className="py-2 text-right font-medium">₹ per unit</th>
                  <th className="py-2 text-right font-medium">Line total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const ing = ingredientById.get(i.ingredientId);
                  const perUnit = ing ? toBaseQty(ing.unit, i.unit, 1) : 1;
                  const received = roundQty(i.qtyReceivedBase / perUnit);
                  return (
                    <tr key={i.id} className="border-t">
                      <td className="py-2">{i.ingredientName}</td>
                      <td className="py-2 text-right tabular-nums">
                        {i.qtyOrdered} {i.unit}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {received} {i.unit}
                        {i.fulfilmentPct !== null ? (
                          <span className="block text-xs text-muted-foreground">{i.fulfilmentPct}%</span>
                        ) : null}
                      </td>
                      <td className="py-2 text-right tabular-nums">₹{paiseToDisplay(i.unitCost)}</td>
                      <td className="py-2 text-right tabular-nums">₹{paiseToDisplay(i.lineTotalMinor)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {canManage && order.status === "draft" ? (
        <Card>
          <CardHeader>
            <CardTitle>Send or cancel</CardTitle>
            <CardDescription>Sending records that the order went to the supplier. It does not move stock.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-2">
            <SendOrderButton businessId={business.id} outletId={outlet.id} purchaseOrderId={id} />
            <CancelOrderForm businessId={business.id} outletId={outlet.id} purchaseOrderId={id} />
          </CardContent>
        </Card>
      ) : null}

      {order.status === "sent" && canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Cancel order</CardTitle>
            <CardDescription>Only possible before any delivery is received.</CardDescription>
          </CardHeader>
          <CardContent>
            <CancelOrderForm businessId={business.id} outletId={outlet.id} purchaseOrderId={id} />
          </CardContent>
        </Card>
      ) : null}

      {canReceive ? (
        <Card>
          <CardHeader>
            <CardTitle>Receive delivery</CardTitle>
            <CardDescription>
              Enter what physically arrived. Each line adds stock at this outlet and is recorded as a goods receipt.
              Receiving more than is outstanding is refused.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {receiveLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everything on this order has been received.</p>
            ) : (
              <ReceiveForm businessId={business.id} outletId={outlet.id} purchaseOrderId={id} lines={receiveLines} />
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Goods receipts</CardTitle>
          <CardDescription>Each delivery is kept as posted. Receipts cannot be edited or deleted.</CardDescription>
        </CardHeader>
        <CardContent>
          {receipts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing received yet.</p>
          ) : (
            <div className="space-y-4">
              {receipts.map((r) => (
                <div key={r.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-medium">
                      GRN-{r.number} · {r.receivedOn}
                      {r.deliveryNote ? <span className="text-muted-foreground"> · note {r.deliveryNote}</span> : null}
                    </span>
                    <Badge variant="outline" className="tabular-nums">
                      ₹{paiseToDisplay(r.valueMinor)}
                    </Badge>
                  </div>
                  <ul className="mt-2 divide-y text-sm">
                    {r.lines.map((l) => (
                      <li key={l.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                        <span>
                          {l.ingredientName}
                          {l.batchCode ? <span className="text-muted-foreground"> · batch {l.batchCode}</span> : null}
                          {l.expiresOn ? <span className="text-muted-foreground"> · expires {l.expiresOn}</span> : null}
                        </span>
                        <span className="tabular-nums">
                          {l.qty} {l.unit} · ₹{paiseToDisplay(l.lineTotalMinor)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
