import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import {
  PurchasingBusinessPicker,
  PurchasingDenied,
  PurchasingNav,
  PurchasingNoOutlet,
} from "@/modules/purchasing/components/purchasing-chrome";
import { SupplierForm } from "@/modules/purchasing/components/supplier-form";
import { loadSupplierBalances, loadSupplierList } from "@/modules/purchasing/queries";
import { paiseToDisplay } from "@/modules/purchasing/money";

export const metadata: Metadata = { title: "Suppliers" };

export default async function SuppliersPage({
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

  const { business, abilities, outlet } = ctx;
  const canManage = abilities.can("purchasing.manage");
  const [suppliers, balances] = await Promise.all([loadSupplierList(business.id), loadSupplierBalances(business.id)]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Suppliers</h1>
        <p className="text-muted-foreground">
          {business.name}. Supplier balances cover every outlet.
        </p>
      </div>

      <PurchasingNav businessId={business.id} outletId={outlet.id} />

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>Supplier directory</CardTitle>
            <CardDescription>Balance is invoiced minus paid. A negative balance is an advance.</CardDescription>
          </CardHeader>
          <CardContent>
            {suppliers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No suppliers yet. Add your first supplier.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-2 font-medium">Supplier</th>
                      <th className="py-2 font-medium">Terms</th>
                      <th className="py-2 text-right font-medium">Balance</th>
                      <th className="py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppliers.map((s) => {
                      const bal = balances.get(s.id);
                      return (
                        <tr key={s.id} className="border-t">
                          <td className="py-2">
                            <Link
                              className="font-medium underline-offset-4 hover:underline"
                              href={`/purchasing/suppliers/${s.id}?business=${business.id}&outlet=${outlet.id}`}
                            >
                              {s.name}
                            </Link>
                            {s.gstin ? <span className="block text-xs text-muted-foreground">GSTIN {s.gstin}</span> : null}
                          </td>
                          <td className="py-2 text-muted-foreground">{s.paymentTermsDays} days</td>
                          <td className="py-2 text-right tabular-nums">
                            ₹{paiseToDisplay(bal?.balanceMinor ?? 0)}
                          </td>
                          <td className="py-2">
                            <Badge variant={s.status === "active" ? "outline" : "secondary"}>
                              {s.status === "active" ? "Active" : "Inactive"}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add a supplier</CardTitle>
            <CardDescription>Supplier names are unique within the business.</CardDescription>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <SupplierForm businessId={business.id} />
            ) : (
              <p className="text-sm text-muted-foreground">You can view suppliers. Managing them needs purchasing access.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
