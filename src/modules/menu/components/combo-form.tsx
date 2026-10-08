"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { createComboAction, updateComboAction, type MenuActionState } from "@/modules/menu/actions";
import { minorToDisplay } from "@/modules/menu/schemas";
import type { ComboDetail } from "@/modules/menu/queries";
import { FieldError, FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";

interface ComboItemEditRow {
  key: number;
  productId: string;
  variantId: string;
  quantity: string;
}

export function ComboForm({
  businessId,
  combo,
  picker,
}: {
  businessId: string;
  combo?: ComboDetail;
  picker: { id: string; name: string; variants: { id: string; name: string }[] }[];
}) {
  const router = useRouter();
  const action = combo ? updateComboAction : createComboAction;
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(action, undefined);
  const [rows, setRows] = useState<ComboItemEditRow[]>(() =>
    combo && combo.items.length > 0
      ? combo.items.map((item, index) => ({
          key: index,
          productId: item.productId,
          variantId: item.variantId ?? "",
          quantity: String(item.quantity),
        }))
      : [{ key: 0, productId: picker[0]?.id ?? "", variantId: "", quantity: "1" }],
  );
  const [nextKey, setNextKey] = useState(() => rows.length + 1);

  useEffect(() => {
    if (state?.ok) {
      if (!combo && state.comboId) {
        router.push(`/menu/combos/${state.comboId}?business=${businessId}`);
      } else {
        router.refresh();
      }
    }
  }, [state, router, combo, businessId]);

  const variantsFor = (productId: string) => picker.find((product) => product.id === productId)?.variants ?? [];

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      {combo ? <input type="hidden" name="comboId" value={combo.id} /> : null}
      <FormError state={state} />
      <FormSuccess message={state?.ok && combo ? "Combo saved." : undefined} />

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="c-name">Combo name</Label>
          <Input id="c-name" name="name" defaultValue={combo?.name ?? ""} maxLength={80} required placeholder="e.g. Family Feast" />
          <FieldError state={state} name="name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="c-sku">SKU (optional)</Label>
          <Input id="c-sku" name="sku" defaultValue={combo?.sku ?? ""} maxLength={32} />
          <FieldError state={state} name="sku" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="c-price">Combo price</Label>
          <Input id="c-price" name="price" defaultValue={combo ? minorToDisplay(combo.priceMinor) : ""} inputMode="decimal" required placeholder="799" />
          <FieldError state={state} name="price" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="c-tax">Tax rate % (blank = business default)</Label>
          <Input id="c-tax" name="taxRate" defaultValue={combo?.taxRatePct ?? ""} inputMode="decimal" />
          <FieldError state={state} name="taxRate" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="c-food">Food type</Label>
          <Select id="c-food" name="foodType" defaultValue={combo?.isVegetarian ? "veg" : "non_veg"}>
            <option value="veg">Vegetarian</option>
            <option value="non_veg">Non-vegetarian</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="c-available">Availability</Label>
          <Select id="c-available" name="isAvailable" defaultValue={combo?.isAvailable ? "yes" : "no"}>
            <option value="yes">Available</option>
            <option value="no">Unavailable</option>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="c-desc">Description (optional)</Label>
          <Input id="c-desc" name="description" defaultValue={combo?.description ?? ""} maxLength={400} />
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">What&apos;s inside</legend>
        {picker.length === 0 ? (
          <p className="text-sm text-muted-foreground">Create products first — combos bundle existing products.</p>
        ) : (
          rows.map((row) => (
            <ComboItemRow
              key={row.key}
              row={row}
              picker={picker}
              variantsFor={variantsFor}
              onRemove={() => setRows((current) => current.filter((r) => r.key !== row.key))}
            />
          ))
        )}
        {picker.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setRows((current) => [
                ...current,
                { key: nextKey, productId: picker[0]?.id ?? "", variantId: "", quantity: "1" },
              ]);
              setNextKey((key) => key + 1);
            }}
          >
            <Plus className="size-4" aria-hidden /> Add product to combo
          </Button>
        ) : null}
        <FieldError state={state} name="comboProductId" />
        <FieldError state={state} name="comboQuantity" />
      </fieldset>

      <SubmitButton label={combo ? "Save combo" : "Create combo"} busyLabel="Saving…" pending={pending} className="sm:w-auto sm:px-8" />
    </form>
  );
}

function ComboItemRow({
  row,
  picker,
  variantsFor,
  onRemove,
}: {
  row: ComboItemEditRow;
  picker: { id: string; name: string }[];
  variantsFor: (productId: string) => { id: string; name: string }[];
  onRemove: () => void;
}) {
  // Local product choice drives the variant select; the hidden inputs carry
  // the submitted values. Keeping them in sync via state keeps FormData exact.
  const [productId, setProductId] = useState(row.productId);
  const [variantId, setVariantId] = useState(row.variantId);
  const variants = variantsFor(productId);

  return (
    <div className="grid grid-cols-[1fr_140px_90px_36px] items-center gap-2">
      <Select
        aria-label="Combo product"
        name="comboProductId"
        value={productId}
        onChange={(event) => {
          setProductId(event.target.value);
          setVariantId("");
        }}
      >
        {picker.map((product) => (
          <option key={product.id} value={product.id}>
            {product.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Variant (optional)"
        name="comboVariantId"
        value={variantId}
        onChange={(event) => setVariantId(event.target.value)}
        disabled={variants.length === 0}
      >
        <option value="">No variant</option>
        {variants.map((variant) => (
          <option key={variant.id} value={variant.id}>
            {variant.name}
          </option>
        ))}
      </Select>
      <Input aria-label="Quantity" name="comboQuantity" defaultValue={row.quantity} inputMode="numeric" placeholder="1" />
      <button
        type="button"
        aria-label="Remove combo item"
        className="flex size-9 items-center justify-center rounded-lg border border-ink/15 text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
        onClick={onRemove}
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </div>
  );
}
