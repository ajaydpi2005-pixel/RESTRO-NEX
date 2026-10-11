"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FormError, SubmitButton } from "@/components/forms/form-bits";
import { compatibleUnits, isIngredientBaseUnit, UNITS } from "@/modules/inventory/units";
import { unitCostRupees } from "@/modules/inventory/math";
import { savePurchaseOrderAction, type PurchasingActionState } from "@/modules/purchasing/actions";
import { paiseToDisplay, rupeesToPaise } from "@/modules/purchasing/money";

export interface PoFormIngredient {
  id: string;
  name: string;
  unit: string;
  costPerUnit: number;
}

export interface PoFormLine {
  key: number;
  ingredientId: string;
  unit: string;
  qty: string;
  unitCost: string;
}

export interface PoFormInitial {
  id: string;
  supplierId: string;
  expectedOn: string | null;
  notes: string | null;
  lines: { ingredientId: string; unit: string; qty: number; unitCost: number }[];
}

const MAX_LINES = 60;

function emptyLine(key: number, ingredients: PoFormIngredient[]): PoFormLine {
  const first = ingredients[0];
  return { key, ingredientId: first?.id ?? "", unit: first ? defaultUnit(first.unit) : "", qty: "", unitCost: "" };
}

function defaultUnit(ingredientUnit: string): string {
  if (!isIngredientBaseUnit(ingredientUnit)) return ingredientUnit;
  return compatibleUnits(ingredientUnit)[0]?.code ?? ingredientUnit;
}

function unitFactor(unit: string): number {
  return UNITS.find((u) => u.code === unit)?.toBase ?? 1;
}

/**
 * Purchase order editor: one row per ingredient, with the unit limited to the
 * ingredient's unit family. Prices are typed in rupees per chosen unit; the
 * server converts them to paise and recomputes every total.
 */
export function PurchaseOrderForm({
  businessId,
  outletId,
  suppliers,
  ingredients,
  initial,
}: {
  businessId: string;
  outletId: string;
  suppliers: { id: string; name: string }[];
  ingredients: PoFormIngredient[];
  initial?: PoFormInitial;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PurchasingActionState | undefined, FormData>(
    savePurchaseOrderAction,
    undefined,
  );
  const [lines, setLines] = useState<PoFormLine[]>(() =>
    initial && initial.lines.length > 0
      ? initial.lines.map((l, i) => ({
          key: i + 1,
          ingredientId: l.ingredientId,
          unit: l.unit,
          qty: String(l.qty),
          unitCost: String(unitCostRupees(l.unitCost)),
        }))
      : [emptyLine(1, ingredients)],
  );
  const [nextKey, setNextKey] = useState(lines.length + 1);

  useEffect(() => {
    if (state?.ok && state.id) router.push(`/purchasing/orders/${state.id}?business=${businessId}&outlet=${outletId}`);
  }, [state, router, businessId, outletId]);

  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
  const usable = lines.filter((l) => l.ingredientId && Number(l.qty) > 0 && l.unitCost !== "");
  const subtotalPaise = usable.reduce((sum, l) => sum + rupeesToPaise(Number(l.qty) * Number(l.unitCost)), 0);

  function update(key: number, patch: Partial<PoFormLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function chooseIngredient(line: PoFormLine, ingredientId: string) {
    const ing = ingredientById.get(ingredientId);
    const unit = ing ? defaultUnit(ing.unit) : line.unit;
    // Pre-fill the last known cost in the chosen unit, but never overwrite what the user typed.
    const prefill =
      line.unitCost === "" && ing ? String(unitCostRupees(ing.costPerUnit * unitFactor(unit))) : line.unitCost;
    update(line.key, { ingredientId, unit, unitCost: prefill });
  }

  function addLine() {
    if (lines.length >= MAX_LINES) return;
    setLines((prev) => [...prev, emptyLine(nextKey, ingredients)]);
    setNextKey((k) => k + 1);
  }

  const payload = JSON.stringify(
    usable.map((l) => ({
      ingredientId: l.ingredientId,
      unit: l.unit,
      qty: Number(l.qty),
      unitCostRupees: Number(l.unitCost),
    })),
  );

  if (ingredients.length === 0) {
    return <p className="text-sm text-muted-foreground">Add an ingredient in Inventory before ordering.</p>;
  }

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="outletId" value={outletId} />
      <input type="hidden" name="id" value={initial?.id ?? ""} />
      <input type="hidden" name="lines" value={payload} />
      <FormError state={state} />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="po-supplier">Supplier</Label>
          <Select id="po-supplier" name="supplierId" required defaultValue={initial?.supplierId ?? ""}>
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
        <div className="space-y-1.5">
          <Label htmlFor="po-expected">Expected delivery</Label>
          <Input id="po-expected" name="expectedOn" type="date" defaultValue={initial?.expectedOn ?? ""} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="po-notes">Notes</Label>
          <Input id="po-notes" name="notes" maxLength={500} defaultValue={initial?.notes ?? ""} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="hidden grid-cols-[2fr_1fr_1fr_1.2fr_auto] gap-2 text-xs font-medium text-muted-foreground sm:grid">
          <span>Ingredient</span>
          <span>Quantity</span>
          <span>Unit</span>
          <span>Price per unit (₹)</span>
          <span />
        </div>
        {lines.map((line, index) => {
          const ing = ingredientById.get(line.ingredientId);
          const units = ing && isIngredientBaseUnit(ing.unit) ? compatibleUnits(ing.unit) : [];
          const label = `Line ${index + 1}`;
          return (
            <div key={line.key} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[2fr_1fr_1fr_1.2fr_auto] sm:border-0 sm:p-0">
              <Select
                aria-label={`${label} ingredient`}
                value={line.ingredientId}
                onChange={(e) => chooseIngredient(line, e.target.value)}
              >
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={`${label} quantity`}
                type="number"
                inputMode="decimal"
                step="0.001"
                min="0"
                placeholder="Qty"
                value={line.qty}
                onChange={(e) => update(line.key, { qty: e.target.value })}
              />
              <Select
                aria-label={`${label} unit`}
                value={line.unit}
                onChange={(e) => update(line.key, { unit: e.target.value })}
              >
                {units.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.label}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={`${label} price per unit`}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                placeholder="₹ per unit"
                value={line.unitCost}
                onChange={(e) => update(line.key, { unitCost: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={lines.length === 1}
                onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={addLine} disabled={lines.length >= MAX_LINES}>
            Add line
          </Button>
          <p className="text-sm tabular-nums">
            Subtotal <span className="font-semibold">₹{paiseToDisplay(subtotalPaise)}</span>
            <span className="text-muted-foreground"> · tax is not added to orders</span>
          </p>
        </div>
      </div>

      <SubmitButton
        label={initial ? "Save draft" : "Create draft order"}
        busyLabel="Saving…"
        pending={pending}
        className="sm:w-auto"
      />
    </form>
  );
}
