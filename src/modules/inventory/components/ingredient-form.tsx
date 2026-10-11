"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FieldError, FormError, FormSuccess } from "@/components/forms/form-bits";
import { saveIngredientAction, type InventoryActionState } from "@/modules/inventory/actions";
import { INGREDIENT_BASE_UNITS } from "@/modules/inventory/units";

export interface IngredientFormValues {
  id?: string;
  name?: string;
  unit?: string;
  costPerUnit?: number;
  minimumStock?: number | null;
  maximumStock?: number | null;
  active?: boolean;
}

const BASE_LABEL: Record<string, string> = { g: "gram", ml: "millilitre", pc: "piece" };

export function IngredientForm({
  businessId,
  initial,
  compact = false,
}: {
  businessId: string;
  initial?: IngredientFormValues;
  compact?: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<InventoryActionState | undefined, FormData>(
    saveIngredientAction,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const isNew = !initial?.id;
  useEffect(() => {
    if (state?.ok && isNew) formRef.current?.reset();
    if (state?.ok) router.refresh();
  }, [state, router, isNew]);

  const unit = initial?.unit ?? "g";
  return (
    <form ref={formRef} action={formAction} className="space-y-3" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      {initial?.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Saved." : undefined} />
      <div className={compact ? "grid gap-3 sm:grid-cols-6" : "grid gap-3 sm:grid-cols-2"}>
        <div className={compact ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
          <Label htmlFor={`ing-name-${initial?.id ?? "new"}`}>Name</Label>
          <Input id={`ing-name-${initial?.id ?? "new"}`} name="name" defaultValue={initial?.name ?? ""} maxLength={80} required />
          <FieldError state={state} name="name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ing-unit-${initial?.id ?? "new"}`}>Base unit</Label>
          <Select id={`ing-unit-${initial?.id ?? "new"}`} name="unit" defaultValue={unit} disabled={Boolean(initial?.id)}>
            {INGREDIENT_BASE_UNITS.map((u) => (
              <option key={u} value={u}>
                {u} ({BASE_LABEL[u]})
              </option>
            ))}
          </Select>
          {initial?.id ? <input type="hidden" name="unit" value={unit} /> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ing-cost-${initial?.id ?? "new"}`}>Standard cost per {unit} (₹)</Label>
          <Input
            id={`ing-cost-${initial?.id ?? "new"}`}
            name="costPerUnit"
            type="number"
            min={0}
            step="0.0001"
            defaultValue={initial?.costPerUnit ?? 0}
            required
          />
          <FieldError state={state} name="costPerUnit" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ing-min-${initial?.id ?? "new"}`}>Minimum ({unit})</Label>
          <Input
            id={`ing-min-${initial?.id ?? "new"}`}
            name="minimumStock"
            type="number"
            min={0}
            step="any"
            defaultValue={initial?.minimumStock ?? ""}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ing-max-${initial?.id ?? "new"}`}>Maximum ({unit})</Label>
          <Input
            id={`ing-max-${initial?.id ?? "new"}`}
            name="maximumStock"
            type="number"
            min={0}
            step="any"
            defaultValue={initial?.maximumStock ?? ""}
          />
          <FieldError state={state} name="maximumStock" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={initial?.active ?? true} className="size-4" />
          Active
        </label>
        <Button type="submit" disabled={pending} size="sm">
          {pending ? "Saving…" : initial?.id ? "Save" : "Add ingredient"}
        </Button>
      </div>
    </form>
  );
}
