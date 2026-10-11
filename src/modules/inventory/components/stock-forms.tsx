"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FieldError, FormError, FormSuccess } from "@/components/forms/form-bits";
import {
  countStockAction,
  receiveStockAction,
  wasteStockAction,
  type InventoryActionState,
} from "@/modules/inventory/actions";
import { compatibleUnits, isIngredientBaseUnit } from "@/modules/inventory/units";

export interface StockFormIngredient {
  id: string;
  name: string;
  unit: string;
}

type Mode = "receive" | "waste" | "count";

const ACTIONS = {
  receive: receiveStockAction,
  waste: wasteStockAction,
  count: countStockAction,
} as const;

const TITLES: Record<Mode, { heading: string; success: string; submit: string }> = {
  receive: { heading: "Receive stock", success: "Stock received.", submit: "Receive" },
  waste: { heading: "Record wastage", success: "Wastage recorded.", submit: "Record wastage" },
  count: { heading: "Count stock", success: "Count posted.", submit: "Post count" },
};

function newRef(): string {
  return crypto.randomUUID();
}

/**
 * One form per stock action. Each submission carries an idempotency key that
 * rotates after success, so a double-click or retry cannot post twice.
 */
export function StockActionForm({
  mode,
  businessId,
  outletId,
  ingredients,
}: {
  mode: Mode;
  businessId: string;
  outletId: string;
  ingredients: StockFormIngredient[];
}) {
  const router = useRouter();
  const action = ACTIONS[mode];
  const [state, formAction, pending] = useActionState<InventoryActionState | undefined, FormData>(action, undefined);
  const [ref, setRef] = useState(newRef);
  const [ingredientId, setIngredientId] = useState(ingredients[0]?.id ?? "");
  const selected = ingredients.find((i) => i.id === ingredientId);
  const units = selected && isIngredientBaseUnit(selected.unit) ? compatibleUnits(selected.unit) : [];

  // Rotate the idempotency key once per successful submission (render-phase
  // update: no effect-driven state churn).
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state?.ok) setRef(newRef());
  }
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const qtyLabel = mode === "count" ? "Counted amount" : "Quantity";
  const title = TITLES[mode];

  if (ingredients.length === 0) {
    return <p className="text-sm text-muted-foreground">Add an ingredient before recording stock.</p>;
  }

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="outletId" value={outletId} />
      <input type="hidden" name="clientRef" value={ref} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? title.success : undefined} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${mode}-ingredient`}>Ingredient</Label>
          <Select
            id={`${mode}-ingredient`}
            name="ingredientId"
            value={ingredientId}
            onChange={(e) => setIngredientId(e.target.value)}
          >
            {ingredients.map((ing) => (
              <option key={ing.id} value={ing.id}>
                {ing.name} ({ing.unit})
              </option>
            ))}
          </Select>
          <FieldError state={state} name="ingredientId" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${mode}-qty`}>{qtyLabel}</Label>
          <Input
            id={`${mode}-qty`}
            name={mode === "count" ? "counted" : "qty"}
            type="number"
            inputMode="decimal"
            min={mode === "count" ? 0 : 0.001}
            step="any"
            required
          />
          <FieldError state={state} name={mode === "count" ? "counted" : "qty"} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${mode}-unit`}>Unit</Label>
          <Select id={`${mode}-unit`} name="unit" key={ingredientId} defaultValue={units[0]?.code}>
            {units.map((unit) => (
              <option key={unit.code} value={unit.code}>
                {unit.label}
              </option>
            ))}
          </Select>
        </div>

        {mode === "receive" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="receive-cost">Cost per unit (₹)</Label>
              <Input id="receive-cost" name="unitCost" type="number" min={0} step="0.01" required />
              <FieldError state={state} name="unitCost" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="receive-batch">Batch code (optional)</Label>
              <Input id="receive-batch" name="batchCode" maxLength={40} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="receive-expiry">Expiry date (optional)</Label>
              <Input id="receive-expiry" name="expiresOn" type="date" />
            </div>
          </>
        ) : null}

        {mode !== "receive" ? (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${mode}-reason`}>Reason</Label>
            <Input
              id={`${mode}-reason`}
              name="reason"
              maxLength={120}
              placeholder={mode === "waste" ? "e.g. expired, dropped, spoiled" : "e.g. monthly count, found on shelf"}
              required
            />
            <FieldError state={state} name="reason" />
          </div>
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending || !selected} variant={mode === "waste" ? "outline" : "default"}>
          {pending ? "Saving…" : title.submit}
        </Button>
      </div>
    </form>
  );
}
