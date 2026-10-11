import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { guardRedirect } from "@/lib/guarded-redirect";
import {
  InventoryBusinessPicker,
  InventoryDenied,
  InventoryNoOutlet,
} from "@/modules/inventory/components/business-picker";
import { InventoryNav } from "@/modules/inventory/components/inventory-chrome";
import { IngredientForm } from "@/modules/inventory/components/ingredient-form";
import { loadIngredients } from "@/modules/inventory/queries";
import { unitCostRupees } from "@/modules/inventory/math";

export const metadata: Metadata = { title: "Ingredients" };

export default async function IngredientsPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params);
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <InventoryBusinessPicker businesses={ctx.businesses} basePath="/inventory/ingredients" />;
  if (ctx.kind === "denied") return <InventoryDenied />;
  if (ctx.kind === "no-outlet") return <InventoryNoOutlet />;

  const { business, abilities } = ctx;
  const canManage = abilities.can("inventory.manage");
  const ingredients = await loadIngredients(business.id);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Inventory</h1>
        <p className="text-muted-foreground">
          {business.name}. Ingredients are shared across outlets. Each one has a single base unit: g, ml or pc.
        </p>
      </div>

      <InventoryNav businessId={business.id} />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Add ingredient</CardTitle>
            <CardDescription>
              Standard cost is per base unit (₹ per g, ml or pc). Receipts carry their own batch cost; standard cost is used for theoretical margin and for shortfalls.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <IngredientForm businessId={business.id} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Ingredients</CardTitle>
          <CardDescription>
            {canManage ? "Expand a row to edit it. Unit cannot change once stock exists." : "Read-only. Editing needs inventory management."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ingredients.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ingredients yet.</p>
          ) : canManage ? (
            <ul className="space-y-2">
              {ingredients.map((ing) => (
                <li key={ing.id}>
                  <details className="rounded-md border px-3 py-2">
                    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="font-medium">{ing.name}</span>
                      <span className="flex items-center gap-3 text-muted-foreground">
                        <span className="tabular-nums">₹{unitCostRupees(ing.costPerUnit)} / {ing.unit}</span>
                        {ing.active ? null : <Badge variant="outline">Inactive</Badge>}
                      </span>
                    </summary>
                    <div className="pt-3">
                      <IngredientForm
                        businessId={business.id}
                        compact
                        initial={{
                          id: ing.id,
                          name: ing.name,
                          unit: ing.unit,
                          costPerUnit: unitCostRupees(ing.costPerUnit),
                          minimumStock: ing.minimumStock,
                          maximumStock: ing.maximumStock,
                          active: ing.active,
                        }}
                      />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="divide-y text-sm">
              {ingredients.map((ing) => (
                <li key={ing.id} className="flex justify-between py-2">
                  <span>{ing.name}</span>
                  <span className="text-muted-foreground">
                    {ing.unit} · ₹{unitCostRupees(ing.costPerUnit)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
