"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { createProductAction, type MenuActionState } from "@/modules/menu/actions";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

export function CreateProductForm({
  businessId,
  categories,
}: {
  businessId: string;
  categories: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(
    createProductAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok && state.productId) {
      router.push(`/menu/products/${state.productId}?business=${businessId}`);
    }
  }, [state, router, businessId]);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-name">Product name</Label>
          <Input id="p-name" name="name" maxLength={80} required placeholder="e.g. Paneer Tikka" />
          <FieldError state={state} name="name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-category">Category</Label>
          <Select id="p-category" name="categoryId" required defaultValue={categories[0]?.id ?? ""}>
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
          <Input id="p-sku" name="sku" maxLength={32} placeholder="PNR-TIK-01" />
          <FieldError state={state} name="sku" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-price">Price</Label>
          <Input id="p-price" name="price" inputMode="decimal" required placeholder="249.50" />
          <FieldError state={state} name="price" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-tax">Tax rate % (blank = business default)</Label>
          <Input id="p-tax" name="taxRate" inputMode="decimal" placeholder="5" />
          <FieldError state={state} name="taxRate" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-food">Food type</Label>
          <Select id="p-food" name="foodType" defaultValue="veg">
            <option value="veg">Vegetarian</option>
            <option value="non_veg">Non-vegetarian</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-available">Availability</Label>
          <Select id="p-available" name="isAvailable" defaultValue="yes">
            <option value="yes">Available</option>
            <option value="no">Unavailable</option>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-desc">Description (optional)</Label>
          <Input id="p-desc" name="description" maxLength={400} placeholder="Char-grilled cottage cheese…" />
        </div>
      </div>

      <SubmitButton label="Create product" busyLabel="Creating…" pending={pending} className="sm:w-auto sm:px-8" />
      <p className="text-xs text-muted-foreground">
        Variants, modifiers, outlet pricing and images are configured on the product page after creation.
      </p>
    </form>
  );
}
