import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { addDays } from "@/modules/inventory/math";
import { businessToday } from "@/modules/inventory/queries";
import { OutletTabs } from "@/modules/inventory/components/inventory-chrome";
import {
  PurchasingBusinessPicker,
  PurchasingDenied,
  PurchasingNav,
  PurchasingNoOutlet,
} from "@/modules/purchasing/components/purchasing-chrome";
import { SupplierInvoiceForm } from "@/modules/purchasing/components/invoice-form";
import { paiseToDisplay } from "@/modules/purchasing/money";
import { loadBillableLines, loadInvoices, loadSupplierList } from "@/modules/purchasing/queries";

export const metadata: Metadata = { title: "Supplier invoices" };

export default async function SupplierInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string; supplier?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params, "purchasing.view");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <PurchasingBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <PurchasingDenied />;
  if (ctx.kind === "no-outlet") return <PurchasingNoOutlet />;

  const { business, abilities, outlets, outlet } = ctx;
  const canManage = abilities.can("purchasing.manage");
  const today = businessToday();
  const [suppliers, invoices] = await Promise.all([
    loadSupplierList(business.id),
    loadInvoices(business.id, outlet.id),
  ]);
  const chosen = suppliers.find((s) => s.id === params.supplier);
  const billable = canManage && chosen ? await loadBillableLines(business.id, outlet.id, chosen.id) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Supplier invoices</h1>
          <p className="text-muted-foreground">
            {business.name} · {outlet.name}. Invoices bill only what was received; each receipt line is billed once.
          </p>
        </div>
        <OutletTabs businessId={business.id} outlets={outlets} activeId={outlet.id} path="/purchasing/invoices" />
      </div>

      <PurchasingNav businessId={business.id} outletId={outlet.id} />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Bill received stock</CardTitle>
            <CardDescription>Choose a supplier to see received lines that have not been billed yet.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form method="get" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="business" value={business.id} />
              <input type="hidden" name="outlet" value={outlet.id} />
              <div className="min-w-64 space-y-1.5">
                <Label htmlFor="inv-supplier-pick">Supplier</Label>
                <Select id="inv-supplier-pick" name="supplier" defaultValue={chosen?.id ?? ""}>
                  <option value="" disabled>
                    Choose a supplier
                  </option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" variant="outline">
                Show received lines
              </Button>
            </form>

            {chosen ? (
              <SupplierInvoiceForm
                key={chosen.id}
                businessId={business.id}
                outletId={outlet.id}
                supplierId={chosen.id}
                lines={billable}
                today={today}
                dueDefault={addDays(today, chosen.paymentTermsDays)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Pick a supplier to bill its received stock.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            You can view supplier invoices. Recording them needs purchasing management access.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recorded invoices</CardTitle>
          <CardDescription>Posted invoices are kept as recorded. Totals are calculated from the billed lines.</CardDescription>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No supplier invoices at this outlet yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Invoice</th>
                    <th className="py-2 font-medium">Supplier</th>
                    <th className="py-2 font-medium">Invoice date</th>
                    <th className="py-2 font-medium">Due</th>
                    <th className="py-2 text-right font-medium">Lines</th>
                    <th className="py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id} className="border-t">
                      <td className="py-2 font-medium">{i.invoiceNumber}</td>
                      <td className="py-2">
                        <Link
                          className="underline-offset-4 hover:underline"
                          href={`/purchasing/suppliers/${i.supplierId}?business=${business.id}&outlet=${outlet.id}`}
                        >
                          {i.supplierName}
                        </Link>
                      </td>
                      <td className="py-2 text-muted-foreground">{i.invoiceDate}</td>
                      <td className="py-2 text-muted-foreground">{i.dueOn}</td>
                      <td className="py-2 text-right tabular-nums">{i.lines}</td>
                      <td className="py-2 text-right tabular-nums">
                        ₹{paiseToDisplay(i.totalMinor)}
                        {i.taxMinor > 0 ? (
                          <span className="block text-xs text-muted-foreground">incl. tax ₹{paiseToDisplay(i.taxMinor)}</span>
                        ) : null}
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
