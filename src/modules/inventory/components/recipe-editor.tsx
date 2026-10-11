"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FormError, FormSuccess } from "@/components/forms/form-bits";
import { saveRecipeAction, type InventoryActionState } from "@/modules/inventory/actions";
import { recipeCostMinor, marginPct } from "@/modules/inventory/math";
import { compatibleUnits, isIngredientBaseUnit, toBaseQty } from "@/modules/inventory/units";
import { minorToDisplay } from "@/modules/menu/schemas";

export interface RecipeIngredientOption {
  id: string;
  name: string;
  unit: string;
  costPerUnit: number;
}

interface Line {
  key: number;
  ingredientId: string;
  unit: string;
  qty: string;
}

export function RecipeEditor({
  businessId,
  menuItemId,
  priceMinor,
  ingredients,
  initialLines,
  canEdit,
}: {
  businessId: string;
  menuItemId: string;
  priceMinor: number;
  ingredients: RecipeIngredientOption[];
  initialLines: { ingredientId: string; unit: string; quantity: number }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<InventoryActionState | undefined, FormData>(
    saveRecipeAction,
    undefined,
  );
  const [nextKey, setNextKey] = useState(1000);
  const [lines, setLines] = useState<Line[]>(() =>
    initialLines.map((line, index) => {
      const ing = ingredients.find((i) => i.id === line.ingredientId);
      return {
        key: index,
        ingredientId: line.ingredientId,
        unit: line.unit || ing?.unit || "g",
        qty: String(line.quantity),
      };
    }),
  );

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  // Live standard cost: the same conversion the database applies on save.
  const preview = useMemo(() => {
    const costLines: { quantity: number; costPerUnit: number }[] = [];
    let error: string | null = null;
    for (const line of lines) {
      const ing = ingredients.find((i) => i.id === line.ingredientId);
      if (!ing) continue;
      const qty = Number(line.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      try {
        costLines.push({ quantity: toBaseQty(ing.unit, line.unit, qty), costPerUnit: ing.costPerUnit });
      } catch (e) {
        error = e instanceof Error ? e.message : "Check the units.";
      }
    }
    const cost = recipeCostMinor(costLines);
    return { cost, margin: marginPct(priceMinor, cost), error };
  }, [lines, ingredients, priceMinor]);

  const payload = JSON.stringify(
    lines
      .filter((l) => l.ingredientId && Number(l.qty) > 0)
      .map((l) => ({ ingredientId: l.ingredientId, unit: l.unit, qty: Number(l.qty) })),
  );

  function update(key: number, patch: Partial<Line>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="menuItemId" value={menuItemId} />
      <input type="hidden" name="lines" value={payload} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Recipe saved." : undefined} />

      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ingredients yet. Sales of this item will not deduct stock.</p>
      ) : null}

      <ul className="space-y-2">
        {lines.map((line) => {
          const ing = ingredients.find((i) => i.id === line.ingredientId);
          const units = ing && isIngredientBaseUnit(ing.unit) ? compatibleUnits(ing.unit) : [];
          return (
            <li key={line.key} className="grid gap-2 sm:grid-cols-[1fr_110px_100px_auto]">
              <Select
                aria-label="Ingredient"
                value={line.ingredientId}
                disabled={!canEdit}
                onChange={(e) => {
                  const next = ingredients.find((i) => i.id === e.target.value);
                  const base = next && isIngredientBaseUnit(next.unit) ? compatibleUnits(next.unit)[0] : undefined;
                  update(line.key, { ingredientId: e.target.value, unit: base?.code ?? "" });
                }}
              >
                <option value="">Choose ingredient</option>
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.unit})
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Quantity"
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                value={line.qty}
                disabled={!canEdit}
                onChange={(e) => update(line.key, { qty: e.target.value })}
              />
              <Select
                aria-label="Unit"
                value={line.unit}
                disabled={!canEdit}
                onChange={(e) => update(line.key, { unit: e.target.value })}
              >
                {units.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.label}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={!canEdit}
                aria-label="Remove line"
                onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canEdit || ingredients.length === 0}
          onClick={() => {
            setNextKey((k) => k + 1);
            setLines((current) => [
              ...current,
              { key: nextKey, ingredientId: "", unit: "", qty: "" },
            ]);
          }}
        >
          <Plus className="size-4" aria-hidden /> Add ingredient
        </Button>
        <div className="text-sm text-muted-foreground">
          Standard cost <span className="font-medium text-foreground">₹{minorToDisplay(Math.round(preview.cost * 100) / 100)}</span>
          {preview.margin !== null ? (
            <>
              {" "}· margin <span className="font-medium text-foreground">{preview.margin}%</span> at ₹{minorToDisplay(priceMinor)}
            </>
          ) : null}
        </div>
      </div>
      {preview.error ? <p className="text-sm text-destructive">{preview.error}</p> : null}

      {canEdit ? (
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={pending || Boolean(preview.error)}>
            {pending ? "Saving…" : "Save recipe"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">You can view this recipe. Editing needs menu management.</p>
      )}
    </form>
  );
}
