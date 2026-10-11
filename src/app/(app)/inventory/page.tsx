import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { guardRedirect } from "@/lib/guarded-redirect";
import {
  InventoryBusinessPicker,
  InventoryDenied,
  InventoryNoOutlet,
} from "@/modules/inventory/components/business-picker";
import { InventoryNav, KpiCard, OutletTabs } from "@/modules/inventory/components/inventory-chrome";
import { StockActionForm, type StockFormIngredient } from "@/modules/inventory/components/stock-forms";
import {
  businessToday,
  loadFoodCostSummary,
  loadReconciliation,
  loadRecentMovements,
  loadStockLevels,
} from "@/modules/inventory/queries";
import { minorToDisplay } from "@/modules/menu/schemas";
import { addDays } from "@/modules/inventory/math";

export const metadata: Metadata = { title: "Inventory" };

const STATUS_LABEL = { out: "Out", low: "Low", ok: "OK", over: "Over max" } as const;
const KIND_LABEL: Record<string, string> = {
  receipt: "Received",
  consumption: "Sold / used",
  wastage: "Wastage",
  adjustment: "Count",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
};

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params);
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <InventoryBusinessPicker businesses={ctx.businesses} basePath="/inventory" />;
  if (ctx.kind === "denied") return <InventoryDenied />;
  if (ctx.kind === "no-outlet") return <InventoryNoOutlet />;

  const { business, abilities, outlets, outlet, userId } = ctx;
  const canManage = abilities.can("inventory.manage");
  const today = businessToday();

  const [{ rows, batches }, movements, food, recon] = await Promise.all([
    loadStockLevels(business.id, outlet.id, today),
    loadRecentMovements(outlet.id, 25),
    loadFoodCostSummary(outlet.id, 30),
    loadReconciliation(userId, outlet.id),
  ]);

  const active = rows.filter((r) => r.active);
  const lowCount = active.filter((r) => r.status === "low" || r.status === "out").length;
  const expiryLimit = addDays(today, 7);
  const expiring = batches.filter((b) => b.state === "expired" || (b.expiresOn !== null && b.expiresOn <= expiryLimit));
  const formIngredients: StockFormIngredient[] = active.map((r) => ({ id: r.id, name: r.name, unit: r.unit }));
  const stockValueMinor = Math.round(
    rows.reduce((sum, r) => sum + Math.max(r.onHand, 0) * r.costPerUnit, 0),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-muted-foreground">
            {business.name} · {outlet.name}. Stock moves only through the ledger; every change is traceable.
          </p>
        </div>
        <OutletTabs businessId={business.id} outlets={outlets} activeId={outlet.id} path="/inventory" />
      </div>

      <InventoryNav businessId={business.id} outletId={outlet.id} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Stock value"
          value={`₹${minorToDisplay(stockValueMinor)}`}
          note="on hand at standard cost"
        />
        <KpiCard
          label="Low or out of stock"
          value={String(lowCount)}
          note={`of ${active.length} active ingredients`}
          tone={lowCount > 0 ? "warn" : undefined}
        />
        <KpiCard
          label="Expiring within 7 days"
          value={String(expiring.length)}
          note="including expired batches"
          tone={expiring.some((b) => b.state === "expired") ? "warn" : undefined}
        />
        <KpiCard
          label="Food cost, last 30 days"
          value={food.pct === null ? "—" : `${food.pct}%`}
          note={
            food.orders === 0
              ? "no completed orders yet"
              : `₹${minorToDisplay(food.costMinor)} on ₹${minorToDisplay(food.salesMinor)} of sales`
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle>Stock on hand</CardTitle>
            <CardDescription>
              Negative stock means a sale used more than was received. It is shown as out and listed as unbatched.
              {recon.mismatches === 0
                ? ` Ledger reconciled for ${recon.checked} ingredient${recon.checked === 1 ? "" : "s"}.`
                : ` ${recon.mismatches} ingredient${recon.mismatches === 1 ? "" : "s"} do not reconcile. Contact support.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No ingredients yet.{" "}
                <Link className="underline" href={`/inventory/ingredients?business=${business.id}`}>
                  Add an ingredient
                </Link>{" "}
                to start tracking stock.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-2 font-medium">Ingredient</th>
                      <th className="py-2 text-right font-medium">On hand</th>
                      <th className="py-2 text-right font-medium">Minimum</th>
                      <th className="py-2 font-medium">Status</th>
                      <th className="py-2 font-medium">Next expiry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.map((row) => (
                      <tr key={row.id} className="border-t">
                        <td className="py-2">{row.name}</td>
                        <td className="py-2 text-right tabular-nums">
                          {row.onHand} {row.unit}
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">
                          {row.minimumStock === null ? "—" : `${row.minimumStock} ${row.unit}`}
                        </td>
                        <td className="py-2">
                          <Badge variant={row.status === "out" || row.status === "low" ? "destructive" : "outline"}>
                            {STATUS_LABEL[row.status]}
                          </Badge>
                        </td>
                        <td className="py-2 text-muted-foreground">{row.nearestExpiry ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          {canManage ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Receive stock</CardTitle>
                  <CardDescription>Goods in from a supplier. Cost is recorded per batch.</CardDescription>
                </CardHeader>
                <CardContent>
                  <StockActionForm mode="receive" businessId={business.id} outletId={outlet.id} ingredients={formIngredients} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Record wastage</CardTitle>
                  <CardDescription>Spoiled, dropped or expired stock. Refused beyond what is on hand.</CardDescription>
                </CardHeader>
                <CardContent>
                  <StockActionForm mode="waste" businessId={business.id} outletId={outlet.id} ingredients={formIngredients} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Count stock</CardTitle>
                  <CardDescription>Enter what is physically on the shelf. The difference is posted with a reason.</CardDescription>
                </CardHeader>
                <CardContent>
                  <StockActionForm mode="count" businessId={business.id} outletId={outlet.id} ingredients={formIngredients} />
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground">
                You can view stock and costs. Receiving, wastage and counts need inventory management.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Expiry watch</CardTitle>
            <CardDescription>Batches that are expired or expire within 7 days, earliest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {expiring.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing expiring soon.</p>
            ) : (
              <ul className="divide-y text-sm">
                {expiring.slice(0, 20).map((b) => (
                  <li key={b.id} className="flex items-center justify-between py-2">
                    <span>
                      {b.ingredientName}
                      {b.batchCode ? <span className="text-muted-foreground"> · {b.batchCode}</span> : null}
                    </span>
                    <span className="flex items-center gap-3 tabular-nums">
                      {b.remaining} {b.unit}
                      <Badge variant={b.state === "expired" ? "destructive" : "outline"}>
                        {b.state === "expired" ? "Expired" : b.expiresOn}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent movements</CardTitle>
            <CardDescription>The last 25 ledger entries at this outlet. Entries are never edited or deleted.</CardDescription>
          </CardHeader>
          <CardContent>
            {movements.length === 0 ? (
              <p className="text-sm text-muted-foreground">No movements yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {movements.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="font-medium">{m.ingredientName}</span>{" "}
                      <span className="text-muted-foreground">
                        · {KIND_LABEL[m.kind] ?? m.kind}
                        {m.reason ? ` · ${m.reason}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {m.qty > 0 ? "+" : ""}
                      {m.qty} {m.unit}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
