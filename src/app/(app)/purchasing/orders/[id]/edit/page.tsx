import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { loadIngredients } from "@/modules/inventory/queries";
import { PurchaseOrderForm } from "@/modules/purchasing/components/po-form";
import {
  PurchasingBusinessPicker,
  PurchasingNav,
  PurchasingNoOutlet,
  PurchasingManageRequired,
} from "@/modules/purchasing/components/purchasing-chrome";
import { loadPurchaseOrder, loadSupplierList } from "@/modules/purchasing/queries";

export const metadata: Metadata = { title: "Edit purchase order" };

export default async function EditPurchaseOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const ctx = await loadInventoryPageContext(query, "purchasing.manage");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <PurchasingBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <PurchasingManageRequired what="Editing purchase orders" />;
  if (ctx.kind === "no-outlet") return <PurchasingNoOutlet />;

  const { business, outlet } = ctx;
  const detail = await loadPurchaseOrder(business.id, outlet.id, id);
  if (!detail) notFound();
  const scope = `business=${business.id}&outlet=${outlet.id}`;
  // Only drafts can change; a sent order is amended by cancelling and re-ordering.
  if (detail.order.status !== "draft") redirect(`/purchasing/orders/${id}?${scope}`);

  const [suppliers, ingredients] = await Promise.all([loadSupplierList(business.id), loadIngredients(business.id)]);
  const { order, items } = detail;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          <Link className="underline-offset-4 hover:underline" href={`/purchasing/orders/${id}?${scope}`}>
            PO-{order.number}
          </Link>{" "}
          / Edit draft
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Edit draft order</h1>
      </div>

      <PurchasingNav businessId={business.id} outletId={outlet.id} />

      <Card>
        <CardHeader>
          <CardTitle>Order details</CardTitle>
          <CardDescription>Saving replaces the lines of this draft. Nothing is sent to the supplier.</CardDescription>
        </CardHeader>
        <CardContent>
          <PurchaseOrderForm
            businessId={business.id}
            outletId={outlet.id}
            suppliers={suppliers.filter((s) => s.status === "active" || s.id === order.supplierId).map((s) => ({ id: s.id, name: s.name }))}
            ingredients={ingredients
              .filter((i) => i.active || items.some((it) => it.ingredientId === i.id))
              .map((i) => ({ id: i.id, name: i.name, unit: i.unit, costPerUnit: i.costPerUnit }))}
            initial={{
              id,
              supplierId: order.supplierId,
              expectedOn: order.expectedOn,
              notes: order.notes,
              lines: items.map((i) => ({
                ingredientId: i.ingredientId,
                unit: i.unit,
                qty: i.qtyOrdered,
                unitCost: i.unitCost,
              })),
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
