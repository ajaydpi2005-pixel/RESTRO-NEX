"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { saveMenuSetupAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import type { MenuCategoryRow } from "@/modules/onboarding/queries";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

interface ItemRow {
  key: number;
  category: string;
  name: string;
  price: string;
  food: "veg" | "non_veg";
  description: string;
}

/** 12050 minor units → "120.50" for the prefill. */
function minorToDisplay(minor: number): string {
  return (minor / 100).toFixed(2).replace(/\.00$/, "");
}

export function MenuStepForm({
  businessId,
  existing,
}: {
  businessId: string;
  existing: MenuCategoryRow[];
}) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    saveMenuSetupAction,
    undefined,
  );
  const [rows, setRows] = useState<ItemRow[]>(() => {
    const flat = existing.flatMap((category) =>
      category.items.map((item) => ({
        category: category.name,
        name: item.name,
        price: minorToDisplay(item.priceMinor),
        food: item.isVegetarian ? ("veg" as const) : ("non_veg" as const),
        description: item.description ?? "",
      })),
    );
    return flat.length > 0
      ? flat.map((row, index) => ({ key: index, ...row }))
      : [{ key: 0, category: "", name: "", price: "", food: "veg", description: "" }];
  });
  const [nextKey, setNextKey] = useState(() => rows.length + 1);

  const categoryNames = [...new Set(rows.map((row) => row.category.trim()).filter(Boolean))];

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />
      <datalist id="menu-category-options">
        {categoryNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.key} className="space-y-2 rounded-xl border border-ink/10 bg-white p-3">
            <div className="grid grid-cols-[1fr_1fr_36px] items-center gap-2 sm:grid-cols-[1.2fr_1.4fr_100px_120px_36px]">
              <Input
                aria-label="Category"
                name="categoryName"
                list="menu-category-options"
                defaultValue={row.category}
                placeholder="Category"
                maxLength={60}
              />
              <Input aria-label="Dish name" name="itemName" defaultValue={row.name} placeholder="Dish name" maxLength={80} />
              <Input
                aria-label="Price"
                name="itemPrice"
                defaultValue={row.price}
                placeholder="Price"
                inputMode="decimal"
                className="sm:w-[100px]"
              />
              <Select aria-label="Food type" name="itemFood" defaultValue={row.food} className="sm:w-[120px]">
                <option value="veg">Veg</option>
                <option value="non_veg">Non-veg</option>
              </Select>
              <button
                type="button"
                aria-label="Remove this item"
                className="flex size-9 items-center justify-center justify-self-end rounded-lg border border-ink/15 text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </div>
            <Input
              aria-label="Description (optional)"
              name="itemDescription"
              defaultValue={row.description}
              placeholder="Description (optional)"
              maxLength={400}
              className="text-sm"
            />
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setRows((current) => [
            ...current,
            { key: nextKey, category: current[current.length - 1]?.category ?? "", name: "", price: "", food: "veg", description: "" },
          ]);
          setNextKey((key) => key + 1);
        }}
      >
        <Plus className="size-4" aria-hidden /> Add item
      </Button>

      <FieldError state={state} name="categoryName" />
      <FieldError state={state} name="itemName" />
      <FieldError state={state} name="itemPrice" />
      <p className="text-xs text-muted-foreground">
        Type a new category name or pick an existing one — items group automatically. Saving replaces your current menu; full menu
        management (variants, combos, availability) arrives later.
      </p>

      <SubmitButton label="Save & continue" busyLabel="Saving…" pending={pending} />
    </form>
  );
}
