import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { businessToday } from "@/modules/inventory/queries";
import { OutletTabs } from "@/modules/inventory/components/inventory-chrome";
import {
  PurchasingBusinessPicker,
  PurchasingDenied,
  PurchasingNav,
  PurchasingNoOutlet,
} from "@/modules/purchasing/components/purchasing-chrome";
import { AGING_BUCKETS, type AgingBucket } from "@/modules/purchasing/aging";
import { paiseToDisplay } from "@/modules/purchasing/money";
import {
  loadPayablesAging,
  loadPurchasingReconciliation,
  loadSpendAndVariance,
  loadSupplierList,
} from "@/modules/purchasing/queries";

export const metadata: Metadata = { title: "Purchase reports" };

const BUCKET_LABEL: Record<AgingBucket, string> = {
  current: "Not yet due",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "90+ days",
};

export default async function PurchaseReportsPage({
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

  const { business, outlets, outlet, userId } = ctx;
  const today = businessToday();
  const [{ spend, variance, invoiceCount }, aging, suppliers, recon] = await Promise.all([
    loadSpendAndVariance(business.id, outlet.id),
    loadPayablesAging(business.id, today),
    loadSupplierList(business.id),
    loadPurchasingReconciliation(userId, outlet.id),
  ]);
  const names = new Map(suppliers.map((s) => [s.id, s.name]));
  const totalSpend = spend.reduce((sum, r) => sum + r.totalMinor, 0);
  const totalOpen = aging.reduce((sum, a) => sum + Math.max(a.balanceMinor, 0), 0);
  const bucketTotals = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b, aging.reduce((sum, a) => sum + a.buckets[b], 0)]),
  ) as Record<AgingBucket, number>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Purchase reports</h1>
          <p className="text-muted-foreground">
            {business.name} · {outlet.name}. Spend and price variance are for this outlet; payables cover all outlets.
          </p>
        </div>
        <OutletTabs businessId={business.id} outlets={outlets} activeId={outlet.id} path="/purchasing/reports" />
      </div>

      <PurchasingNav businessId={business.id} outletId={outlet.id} />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Spend by supplier</CardTitle>
            <CardDescription>
              {invoiceCount} invoice{invoiceCount === 1 ? "" : "s"} · total ₹{paiseToDisplay(totalSpend)} including tax
            </CardDescription>
          </CardHeader>
          <CardContent>
            {spend.length === 0 ? (
              <p className="text-sm text-muted-foreground">No supplier invoices yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Supplier</th>
                    <th className="py-2 text-right font-medium">Invoices</th>
                    <th className="py-2 text-right font-medium">Subtotal</th>
                    <th className="py-2 text-right font-medium">Tax</th>
                    <th className="py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {spend.map((r) => (
                    <tr key={r.supplierId} className="border-t">
                      <td className="py-2">{r.supplierName}</td>
                      <td className="py-2 text-right tabular-nums">{r.invoices}</td>
                      <td className="py-2 text-right tabular-nums">₹{paiseToDisplay(r.subtotalMinor)}</td>
                      <td className="py-2 text-right tabular-nums">₹{paiseToDisplay(r.taxMinor)}</td>
                      <td className="py-2 text-right tabular-nums">₹{paiseToDisplay(r.totalMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Price variance</CardTitle>
            <CardDescription>
              Billed lines that differ from the order price. Positive means billed above the order. Net{" "}
              <span className="font-medium">₹{paiseToDisplay(variance.netMinor)}</span>
              {variance.overchargeMinor > 0 ? (
                <>
                  , overcharged <span className="font-medium">₹{paiseToDisplay(variance.overchargeMinor)}</span>
                </>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {variance.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Every billed line matches its order price.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Ingredient</th>
                    <th className="py-2 font-medium">Supplier</th>
                    <th className="py-2 text-right font-medium">Qty</th>
                    <th className="py-2 text-right font-medium">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {variance.rows.map((r, i) => (
                    <tr key={`${r.ingredientName}-${i}`} className="border-t">
                      <td className="py-2">{r.ingredientName}</td>
                      <td className="py-2 text-muted-foreground">{r.supplierName}</td>
                      <td className="py-2 text-right tabular-nums">
                        {r.qty} {r.unit}
                      </td>
                      <td
                        className={`py-2 text-right tabular-nums ${r.varianceMinor > 0 ? "text-destructive" : ""}`}
                      >
                        {r.varianceMinor > 0 ? "+" : ""}₹{paiseToDisplay(r.varianceMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payables ageing</CardTitle>
          <CardDescription>
            Owed to suppliers across all outlets, as of today (IST). Payments are applied to the oldest invoices first.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-6">
            <div className="rounded-lg border p-2">
              <dt className="text-xs text-muted-foreground">Total owed</dt>
              <dd className="font-medium tabular-nums">₹{paiseToDisplay(totalOpen)}</dd>
            </div>
            {AGING_BUCKETS.map((b) => (
              <div key={b} className="rounded-lg border p-2">
                <dt className="text-xs text-muted-foreground">{BUCKET_LABEL[b]}</dt>
                <dd className="font-medium tabular-nums">₹{paiseToDisplay(bucketTotals[b])}</dd>
              </div>
            ))}
          </dl>
          {aging.length === 0 ? (
            <p className="text-sm text-muted-foreground">No supplier balances yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Supplier</th>
                    <th className="py-2 text-right font-medium">Invoiced</th>
                    <th className="py-2 text-right font-medium">Paid</th>
                    <th className="py-2 text-right font-medium">Balance</th>
                    {AGING_BUCKETS.map((b) => (
                      <th key={b} className="py-2 text-right font-medium">
                        {BUCKET_LABEL[b]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {aging.map((a) => (
                    <tr key={a.supplierId} className="border-t">
                      <td className="py-2">{names.get(a.supplierId) ?? "Supplier"}</td>
                      <td className="py-2 text-right tabular-nums">₹{paiseToDisplay(a.invoicedMinor)}</td>
                      <td className="py-2 text-right tabular-nums">₹{paiseToDisplay(a.paidMinor)}</td>
                      <td className="py-2 text-right tabular-nums font-medium">
                        ₹{paiseToDisplay(a.balanceMinor)}
                        {a.balanceMinor < 0 ? <Badge variant="outline" className="ml-2">advance</Badge> : null}
                      </td>
                      {AGING_BUCKETS.map((b) => (
                        <td key={b} className="py-2 text-right tabular-nums text-muted-foreground">
                          {a.buckets[b] > 0 ? `₹${paiseToDisplay(a.buckets[b])}` : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reconciliation checks</CardTitle>
          <CardDescription>Each check compares purchasing records with the inventory ledger for this outlet.</CardDescription>
        </CardHeader>
        <CardContent>
          {recon.error ? (
            <p className="text-sm text-destructive">Reconciliation could not run. Contact support.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 font-medium">Check</th>
                  <th className="py-2 text-right font-medium">Expected</th>
                  <th className="py-2 text-right font-medium">Actual</th>
                  <th className="py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {recon.checks.map((c) => (
                  <tr key={c.name} className="border-t">
                    <td className="py-2">{c.name}</td>
                    <td className="py-2 text-right tabular-nums">{c.expected}</td>
                    <td className="py-2 text-right tabular-nums">{c.actual}</td>
                    <td className="py-2">
                      <Badge variant={c.ok ? "outline" : "destructive"}>{c.ok ? "Agrees" : "Mismatch"}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
