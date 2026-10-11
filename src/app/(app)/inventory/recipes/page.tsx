import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { guardRedirect } from "@/lib/guarded-redirect";
import {
  InventoryBusinessPicker,
  InventoryDenied,
  InventoryNoOutlet,
} from "@/modules/inventory/components/business-picker";
import { InventoryNav } from "@/modules/inventory/components/inventory-chrome";
import { RecipeEditor } from "@/modules/inventory/components/recipe-editor";
import { loadIngredients, loadRecipes } from "@/modules/inventory/queries";
import { minorToDisplay } from "@/modules/menu/schemas";

export const metadata: Metadata = { title: "Recipes" };

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params);
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <InventoryBusinessPicker businesses={ctx.businesses} basePath="/inventory/recipes" />;
  if (ctx.kind === "denied") return <InventoryDenied />;
  if (ctx.kind === "no-outlet") return <InventoryNoOutlet />;

  const { business, abilities } = ctx;
  const canEdit = abilities.can("menu.manage");
  const [recipes, ingredients] = await Promise.all([loadRecipes(business.id), loadIngredients(business.id)]);
  const options = ingredients.filter((i) => i.active).map((i) => ({ id: i.id, name: i.name, unit: i.unit, costPerUnit: i.costPerUnit }));
  const withRecipe = recipes.filter((r) => r.lines.length > 0).length;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Recipes &amp; food cost</h1>
        <p className="text-muted-foreground">
          {business.name}. A completed order deducts its recipes from the outlet&apos;s stock. Combos deduct their component recipes. Modifiers have no recipe lines.
        </p>
      </div>

      <InventoryNav businessId={business.id} />

      <Card>
        <CardHeader>
          <CardTitle>Theoretical margin</CardTitle>
          <CardDescription>
            Standard cost from the ingredient cost per base unit. {withRecipe} of {recipes.length} products have a recipe.
            Actual food cost, from batch costs, is on the stock page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recipes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No products yet. Add products in the menu first.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Product</th>
                    <th className="py-2 text-right font-medium">Price</th>
                    <th className="py-2 text-right font-medium">Standard cost</th>
                    <th className="py-2 text-right font-medium">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {recipes.map((r) => (
                    <tr key={r.menuItemId} className="border-t">
                      <td className="py-2">
                        {r.name}
                        {r.lines.length === 0 ? <span className="text-muted-foreground"> · no recipe</span> : null}
                      </td>
                      <td className="py-2 text-right tabular-nums">₹{minorToDisplay(r.priceMinor)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {r.lines.length === 0 ? "—" : `₹${minorToDisplay(r.costMinor)}`}
                      </td>
                      <td className="py-2 text-right tabular-nums">{r.marginPct === null || r.lines.length === 0 ? "—" : `${r.marginPct}%`}</td>
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
          <CardTitle>Recipes</CardTitle>
          <CardDescription>
            {canEdit
              ? "Expand a product to edit its recipe. Quantities are converted to base units when saved."
              : "Read-only. Editing a recipe needs menu management."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recipes.length === 0 ? null : (
            <ul className="space-y-2">
              {recipes.map((r) => (
                <li key={r.menuItemId}>
                  <details className="rounded-md border px-3 py-2">
                    <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm">
                      <span className="font-medium">{r.name}</span>
                      <span className="text-muted-foreground">{r.lines.length} ingredient{r.lines.length === 1 ? "" : "s"}</span>
                    </summary>
                    <div className="pt-3">
                      <RecipeEditor
                        businessId={business.id}
                        menuItemId={r.menuItemId}
                        priceMinor={r.priceMinor}
                        ingredients={options}
                        initialLines={r.lines.map((l) => ({ ingredientId: l.ingredientId, unit: l.unit, quantity: l.quantity }))}
                        canEdit={canEdit}
                      />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
