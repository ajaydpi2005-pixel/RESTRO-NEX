import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { minorToDisplay } from "@/modules/menu/schemas";
import { OrderActions } from "@/modules/orders/components/order-actions";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { resolveOrdersBusiness } from "@/modules/orders/context";
import { loadOrderDetail } from "@/modules/orders/queries";
import {
  ORDER_STATE_LABELS,
  ORDER_TYPE_LABELS,
  isOrderState,
  type OrderState,
  type OrderType,
} from "@/modules/orders/state";
import { cn } from "@/lib/utils";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Order" };

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ business?: string }>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const { withOrdersView, business } = await resolveOrdersBusiness(search.business);
  if (withOrdersView.length === 0) return await guardRedirect("/settings");
  if (!business) return <OrdersBusinessPicker businesses={withOrdersView} basePath="/orders" />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("orders.view")) {
    return <p className="text-muted-foreground">You don&apos;t have permission to view this order.</p>;
  }

  const order = await loadOrderDetail(business.id, id);
  if (!order) notFound();

  const state = isOrderState(order.status) ? order.status : null;
  const money = (minor: number) => `₹${minorToDisplay(minor)}`;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href={`/orders?business=${business.id}`}
          className="text-sm text-muted-foreground hover:text-ink"
        >
          ← All orders
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Order #{order.orderNumber}</h1>
          {state ? (
            <Badge className={cn("border-0 px-3 py-1 text-sm font-medium", state === "cancelled" && "bg-destructive/10 text-destructive")}>
              {ORDER_STATE_LABELS[state]}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {ORDER_TYPE_LABELS[order.orderType as OrderType] ?? order.orderType}
          {order.tableName ? ` · Table ${order.tableName}` : ""} · {order.outletName} ·{" "}
          {new Date(order.createdAt).toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>

      {state ? (
        <OrderActions
          businessId={business.id}
          orderId={order.id}
          outletId={order.outletId}
          status={state}
          canManage={abilities.can("orders.manage")}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Items</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {order.items.map((item) => (
                <div key={item.id} className="text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-medium">
                      {item.quantity} × {item.name}
                    </p>
                    <span className="tabular-nums">{money(item.lineTotalMinor)}</span>
                  </div>
                  {item.modifiers.length > 0 ? (
                    <ul className="mt-0.5 ml-6 list-disc text-xs text-muted-foreground">
                      {item.modifiers.map((m) => (
                        <li key={m.id}>
                          {m.quantity > 1 ? `${m.quantity} × ` : ""}
                          {m.name} {m.priceMinor > 0 ? `(+${money(m.priceMinor)})` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {item.itemNotes ? (
                    <p className="mt-0.5 ml-6 text-xs text-gold-deep italic">“{item.itemNotes}”</p>
                  ) : null}
                </div>
              ))}
              <Separator />
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">{money(order.subtotalMinor)}</span>
                </div>
                {order.discountMinor > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Discount{" "}
                      {order.discountType === "percent"
                        ? `(${order.discountValue}%)`
                        : order.discountType === "flat"
                          ? `(${money(order.discountValue)})`
                          : ""}
                    </span>
                    <span className="text-green-700 tabular-nums">−{money(order.discountMinor)}</span>
                  </div>
                ) : null}
                {order.taxMinor > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tax (exclusive)</span>
                    <span className="tabular-nums">{money(order.taxMinor)}</span>
                  </div>
                ) : null}
                {order.charges.map((charge) => (
                  <div key={charge.name} className="flex justify-between">
                    <span className="text-muted-foreground">{charge.name}</span>
                    <span className="tabular-nums">{money(Number(charge.amount_minor))}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{money(order.totalMinor)}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    Payment: {order.paymentStatus}
                    {order.paidMinor > 0 ? ` · paid ${money(order.paidMinor)}` : ""}
                  </span>
                  <span>Payment collection arrives in Phase 10</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status history</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2">
                {order.history.map((h) => (
                  <li key={h.id} className="flex items-baseline justify-between gap-3 text-sm">
                    <span>
                      {h.fromStatus ? (
                        <>
                          <span className="text-muted-foreground">{ORDER_STATE_LABELS[h.fromStatus as OrderState] ?? h.fromStatus}</span>
                          <span className="mx-1.5 text-muted-foreground">→</span>
                        </>
                      ) : (
                        <span className="mr-1.5 text-muted-foreground">Created as</span>
                      )}
                      <span className="font-medium">{ORDER_STATE_LABELS[h.toStatus as OrderState] ?? h.toStatus}</span>
                      {h.note ? <span className="ml-2 text-xs text-muted-foreground">“{h.note}”</span> : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(h.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Customer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{order.customerName ?? "Walk-in / unnamed"}</p>
            {order.customerPhone ? <p className="text-muted-foreground">📞 {order.customerPhone}</p> : null}
            {order.deliveryAddress ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Deliver to:</span> {order.deliveryAddress}
              </p>
            ) : null}
            {order.notes ? (
              <>
                <Separator />
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Notes:</span> {order.notes}
                </p>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
