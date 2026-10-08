import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { minorToDisplay } from "@/modules/menu/schemas";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { resolveOrdersBusiness } from "@/modules/orders/context";
import { loadOrders, loadPosOutlets } from "@/modules/orders/queries";
import { ORDER_STATE_LABELS, ORDER_TYPE_LABELS, isOrderState, type OrderState, type OrderType } from "@/modules/orders/state";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Orders" };

const GROUPS = ["active", "completed", "cancelled"] as const;
type Group = (typeof GROUPS)[number];

const STATUS_TONES: Record<OrderState, string> = {
  open: "bg-gold/15 text-gold-deep",
  held: "bg-muted text-muted-foreground",
  placed: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  preparing: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  ready: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  completed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  cancelled: "bg-destructive/10 text-destructive",
};

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string; group?: string }>;
}) {
  const params = await searchParams;
  const { withOrdersView, business } = await resolveOrdersBusiness(params.business);
  if (withOrdersView.length === 0) redirect("/settings");
  if (!business) return <OrdersBusinessPicker businesses={withOrdersView} basePath="/orders" />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("orders.view")) {
    return (
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Orders</h1>
        <p className="text-muted-foreground">You don&apos;t have permission to view orders in this business.</p>
      </div>
    );
  }

  const membership = abilities.userId ? await findActiveMembership(abilities.userId, business.id) : null;
  if (!membership) redirect("/settings");
  const outlets = await loadPosOutlets(business.id, membership.role, membership.id);

  const group: Group = GROUPS.includes(params.group as Group) ? (params.group as Group) : "active";
  const outletId = outlets.some((o) => o.id === params.outlet) ? params.outlet! : null;
  const orders = await loadOrders(business.id, { outletId, group });

  const qs = (over: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    next.set("business", business.id);
    if (over.group ?? group) next.set("group", over.group ?? group);
    if (over.outlet ?? outletId) next.set("outlet", (over.outlet ?? outletId)!);
    return next.toString();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <Link href={`/pos?business=${business.id}`} className="text-sm text-muted-foreground hover:text-ink">
            ← Back to POS
          </Link>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Orders</h1>
          <p className="text-muted-foreground">
            {orders.length} {group} order{orders.length === 1 ? "" : "s"} · {business.name}
          </p>
        </div>
        <OutletFilter
          outlets={outlets.map((o) => ({ id: o.id, name: o.name }))}
          current={outletId}
          basePath={`/orders?business=${business.id}&group=${group}`}
        />
      </div>

      <div className="flex gap-1 rounded-lg bg-muted p-1 sm:w-fit">
        {GROUPS.map((g) => (
          <Link
            key={g}
            href={`/orders?${qs({ group: g })}`}
            className={cn(
              "flex-1 rounded-md px-4 py-1.5 text-center text-sm font-medium capitalize transition sm:flex-none",
              group === g ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {g}
          </Link>
        ))}
      </div>

      {orders.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No {group} orders{outletId ? " at this outlet" : ""} yet.{" "}
            <Link href={`/pos?business=${business.id}`} className="text-gold-deep underline-offset-4 hover:underline">
              Take one in the POS →
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {orders.map((order) => {
            const state = isOrderState(order.status) ? order.status : null;
            return (
              <Link
                key={order.id}
                href={`/orders/${order.id}?business=${business.id}`}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition hover:border-gold/60 sm:grid-cols-[4rem_6rem_1fr_auto_auto]"
              >
                <span className="text-sm font-semibold tabular-nums">#{order.orderNumber}</span>
                <span className="hidden text-sm text-muted-foreground sm:block">
                  {ORDER_TYPE_LABELS[order.orderType as OrderType] ?? order.orderType}
                  {order.tableName ? ` · ${order.tableName}` : ""}
                </span>
                <span className="truncate text-sm">
                  {order.itemCount} item{order.itemCount === 1 ? "" : "s"}
                  {order.customerName ? ` · ${order.customerName}` : ""}
                  <span className="text-xs text-muted-foreground"> · {order.outletName}</span>
                </span>
                <span className="hidden text-xs text-muted-foreground sm:block">
                  {new Date(order.createdAt).toLocaleString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="flex items-center justify-end gap-3">
                  <span className="text-sm font-semibold tabular-nums">₹{minorToDisplay(order.totalMinor)}</span>
                  {state ? (
                    <Badge className={cn("border-0 font-medium", STATUS_TONES[state])}>
                      {ORDER_STATE_LABELS[state]}
                    </Badge>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OutletFilter({
  outlets,
  current,
  basePath,
}: {
  outlets: { id: string; name: string }[];
  current: string | null;
  basePath: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 text-sm">
      <Link
        href={basePath}
        className={cn(
          "rounded-md border px-2.5 py-1",
          !current ? "border-ink bg-ink text-parchment" : "border-border text-muted-foreground hover:text-ink",
        )}
      >
        All outlets
      </Link>
      {outlets.map((o) => (
        <Link
          key={o.id}
          href={`${basePath}&outlet=${o.id}`}
          className={cn(
            "rounded-md border px-2.5 py-1",
            current === o.id ? "border-ink bg-ink text-parchment" : "border-border text-muted-foreground hover:text-ink",
          )}
        >
          {o.name}
        </Link>
      ))}
    </div>
  );
}
