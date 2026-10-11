import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { loadIngredients } from "@/modules/inventory/queries";
import { PurchaseOrderForm } from "@/modules/purchasing/components/po-form";
import {
  PurchasingBusinessPicker,
  PurchasingManageRequired,
  PurchasingNav,
  PurchasingNoOutlet,
} from "@/modules/purchasing/components/purchasing-chrome";
import { loadSupplierList } from "@/modules/purchasing/queries";

export const metadata: Metadata = { title: "New purchase order" };

export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params, "purchasing.manage");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <PurchasingBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <PurchasingManageRequired what="Creating purchase orders" />;
  if (ctx.kind === "no-outlet") return <PurchasingNoOutlet />;

  const { business, outlet } = ctx;
  const [suppliers, ingredients] = await Promise.all([loadSupplierList(business.id), loadIngredients(business.id)]);
  const activeSuppliers = suppliers.filter((s) => s.status === "active");
  const activeIngredients = ingredients.filter((i) => i.active);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          <Link
            className="underline-offset-4 hover:underline"
            href={`/purchasing/orders?business=${business.id}&outlet=${outlet.id}`}
          >
            Orders
          </Link>{" "}
          / New
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">New purchase order</h1>
        <p className="text-muted-foreground">
          {business.name} · {outlet.name}. Save as a draft, then send it to the supplier.
        </p>
      </div>

      <PurchasingNav businessId={business.id} outletId={outlet.id} />

      <Card>
        <CardHeader>
          <CardTitle>Order details</CardTitle>
          <CardDescription>Quantities and prices are in the unit you choose on each line.</CardDescription>
        </CardHeader>
        <CardContent>
          {activeSuppliers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add an active supplier first, on the{" "}
              <Link className="underline" href={`/purchasing/suppliers?business=${business.id}&outlet=${outlet.id}`}>
                suppliers page
              </Link>
              .
            </p>
          ) : (
            <PurchaseOrderForm
              businessId={business.id}
              outletId={outlet.id}
              suppliers={activeSuppliers.map((s) => ({ id: s.id, name: s.name }))}
              ingredients={activeIngredients.map((i) => ({ id: i.id, name: i.name, unit: i.unit, costPerUnit: i.costPerUnit }))}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
