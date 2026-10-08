"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { updateProductAction, type MenuActionState } from "@/modules/menu/actions";
import { minorToDisplay } from "@/modules/menu/schemas";
import type { ProductDetail } from "@/modules/menu/queries";
import { FieldError, FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";

interface VariantEditRow {
  key: number;
  id: string;
  name: string;
  price: string;
  sku: string;
}

export function ProductEditorForm({
  businessId,
  product,
  categories,
}: {
  businessId: string;
  product: ProductDetail;
  categories: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(
    updateProductAction,
    undefined,
  );
  const [variantRows, setVariantRows] = useState<VariantEditRow[]>(() =>
    product.variants.map((variant, index) => ({
      key: index,
      id: variant.id,
      name: variant.name,
      price: minorToDisplay(variant.priceMinor),
      sku: variant.sku ?? "",
    })),
  );
  const [nextKey, setNextKey] = useState(() => variantRows.length + 1);

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-6" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="productId" value={product.id} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Product saved." : undefined} />

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-name">Product name</Label>
          <Input id="p-name" name="name" defaultValue={product.name} maxLength={80} required />
          <FieldError state={state} name="name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-category">Category</Label>
          <Select id="p-category" name="categoryId" defaultValue={product.categoryId}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </Select>
          <FieldError state={state} name="categoryId" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-sku">SKU (optional)</Label>
          <Input id="p-sku" name="sku" defaultValue={product.sku ?? ""} maxLength={32} />
          <FieldError state={state} name="sku" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-price">Base price</Label>
          <Input id="p-price" name="price" defaultValue={minorToDisplay(product.priceMinor)} inputMode="decimal" required />
          <FieldError state={state} name="price" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-tax">Tax rate % (blank = business default)</Label>
          <Input id="p-tax" name="taxRate" defaultValue={product.taxRatePct ?? ""} inputMode="decimal" />
          <FieldError state={state} name="taxRate" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-food">Food type</Label>
          <Select id="p-food" name="foodType" defaultValue={product.isVegetarian ? "veg" : "non_veg"}>
            <option value="veg">Vegetarian</option>
            <option value="non_veg">Non-vegetarian</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-available">Availability</Label>
          <Select id="p-available" name="isAvailable" defaultValue={product.isAvailable ? "yes" : "no"}>
            <option value="yes">Available</option>
            <option value="no">Unavailable</option>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-desc">Description (optional)</Label>
          <Input id="p-desc" name="description" defaultValue={product.description ?? ""} maxLength={400} />
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Variants</legend>
        <p className="text-xs text-muted-foreground">
          Variants sell at their own price (e.g. Half / Full). Removing a row deletes that variant.
        </p>
        {variantRows.map((row) => (
          <div key={row.key} className="grid grid-cols-[32px_1fr_110px_140px_36px] items-center gap-2">
            <input type="hidden" name="variantId" value={row.id} />
            <span className="text-xs text-muted-foreground">{row.id ? "" : "new"}</span>
            <Input aria-label="Variant name" name="variantName" defaultValue={row.name} placeholder="e.g. Full" maxLength={60} />
            <Input aria-label="Variant price" name="variantPrice" defaultValue={row.price} inputMode="decimal" placeholder="250" />
            <Input aria-label="Variant SKU" name="variantSku" defaultValue={row.sku} placeholder="SKU (optional)" maxLength={32} />
            <button
              type="button"
              aria-label="Remove variant"
              className="flex size-9 items-center justify-center rounded-lg border border-ink/15 text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
              onClick={() => setVariantRows((current) => current.filter((r) => r.key !== row.key))}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setVariantRows((current) => [...current, { key: nextKey, id: "", name: "", price: "", sku: "" }]);
            setNextKey((key) => key + 1);
          }}
        >
          <Plus className="size-4" aria-hidden /> Add variant
        </Button>
        <FieldError state={state} name="variantName" />
        <FieldError state={state} name="variantPrice" />
        <FieldError state={state} name="variantSku" />
      </fieldset>

      <SubmitButton label="Save product" busyLabel="Saving…" pending={pending} className="sm:w-auto sm:px-8" />
    </form>
  );
}
