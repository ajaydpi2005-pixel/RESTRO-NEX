import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { businessToday } from "@/modules/inventory/queries";
import { KpiCard, OutletTabs } from "@/modules/inventory/components/inventory-chrome";
import {
  PurchasingBusinessPicker,
  PurchasingDenied,
  PurchasingNav,
  PurchasingNoOutlet,
  StatusBadge,
} from "@/modules/purchasing/components/purchasing-chrome";
import { loadPurchasingOverview, loadPurchasingReconciliation } from "@/modules/purchasing/queries";
import { paiseToDisplay } from "@/modules/purchasing/money";

export const metadata: Metadata = { title: "Purchasing" };

export default async function PurchasingOverviewPage({
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

  const { business, abilities, outlets, outlet, userId } = ctx;
  const canManage = abilities.can("purchasing.manage");
  const today = businessToday();
  const [overview, recon] = await Promise.all([
    loadPurchasingOverview(business.id, outlet.id, today),
    loadPurchasingReconciliation(userId, outlet.id),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Purchasing</h1>
          <p className="text-muted-foreground">
            {business.name} · {outlet.name}. Receiving stock adds it to the inventory ledger.
          </p>
        </div>
        <OutletTabs businessId={business.id} outlets={outlets} activeId={outlet.id} path="/purchasing" />
      </div>

      <PurchasingNav businessId={business.id} outletId={outlet.id} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Open orders"
          value={String(overview.openOrders.length)}
          note="sent or part received, at this outlet"
        />
        <KpiCard
          label="Owed to suppliers"
          value={`₹${paiseToDisplay(overview.payableMinor)}`}
          note="across all outlets, after payments"
        />
        <KpiCard
          label="Overdue"
          value={`₹${paiseToDisplay(overview.overdueMinor)}`}
          note="invoices past their due date"
          tone={overview.overdueMinor > 0 ? "warn" : undefined}
        />
        <KpiCard
          label="Received, not yet billed"
          value={String(overview.unbilledLines)}
          note="lines waiting for a supplier invoice"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle>Open orders</CardTitle>
            <CardDescription>Orders sent to suppliers that still have stock to receive.</CardDescription>
          </CardHeader>
          <CardContent>
            {overview.openOrders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open orders.{" "}
                {canManage ? (
                  <Link className="underline" href={`/purchasing/orders/new?business=${business.id}&outlet=${outlet.id}`}>
                    Create an order
                  </Link>
                ) : null}
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {overview.openOrders.slice(0, 10).map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      href={`/purchasing/orders/${o.id}?business=${business.id}&outlet=${outlet.id}`}
                    >
                      PO-{o.number} · {o.supplierName}
                    </Link>
                    <span className="flex items-center gap-3 tabular-nums">
                      <span className="text-muted-foreground">
                        {o.linesComplete} of {o.lines} lines in full
                      </span>
                      <StatusBadge status={o.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Latest deliveries</CardTitle>
            <CardDescription>The five most recent goods receipts at this outlet.</CardDescription>
          </CardHeader>
          <CardContent>
            {overview.receipts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deliveries received yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {overview.receipts.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                    <span>
                      GRN-{r.number} · {r.supplierName}
                      <span className="block text-xs text-muted-foreground">
                        {r.receivedOn} · PO-{r.purchaseOrderNumber}
                      </span>
                    </span>
                    <Badge variant="outline" className="tabular-nums">
                      ₹{paiseToDisplay(r.valueMinor)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stock reconciliation</CardTitle>
          <CardDescription>
            Purchasing agrees with the inventory ledger when every check below passes.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {recon.error ? (
            <p className="text-destructive">Reconciliation could not run. Contact support.</p>
          ) : recon.mismatches === 0 ? (
            <p>All {recon.checks.length} purchasing checks agree with the ledger.</p>
          ) : (
            <p className="text-destructive">
              {recon.mismatches} check{recon.mismatches === 1 ? "" : "s"} do not agree. Contact support before posting
              more receipts.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
