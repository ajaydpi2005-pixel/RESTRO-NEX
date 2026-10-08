"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { bulkProductsAction, type MenuActionState } from "@/modules/menu/actions";
import { minorToDisplay } from "@/modules/menu/schemas";
import { menuImageUrl } from "@/modules/menu/image";
import { FormError } from "@/components/forms/form-bits";
import type { ProductRow } from "@/modules/menu/queries";

export function ProductsTable({
  businessId,
  products,
  canManage,
}: {
  businessId: string;
  products: ProductRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(
    bulkProductsAction,
    undefined,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const allSelected = products.length > 0 && selected.size === products.length;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(products.map((product) => product.id)));
  };
  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="businessId" value={businessId} />
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {selected.size === 0 ? "Select products for bulk actions" : `${selected.size} selected`}
          </span>
          <div className="ml-auto flex gap-2">
            <Button type="submit" name="bulkMode" value="available" size="sm" variant="outline" disabled={pending || selected.size === 0}>
              Mark available
            </Button>
            <Button type="submit" name="bulkMode" value="unavailable" size="sm" variant="outline" disabled={pending || selected.size === 0}>
              Mark unavailable
            </Button>
            <Button
              type="submit"
              name="bulkMode"
              value="delete"
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={pending || selected.size === 0}
              onClick={(event) => {
                if (!window.confirm(`Delete ${selected.size} product(s)? This cannot be undone.`)) {
                  event.preventDefault();
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      ) : null}
      <FormError state={state} />

      <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-ink/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
              {canManage ? (
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all products"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="size-4 accent-ink"
                  />
                </th>
              ) : null}
              <th className="px-3 py-2.5">Product</th>
              <th className="px-3 py-2.5">Category</th>
              <th className="px-3 py-2.5">SKU</th>
              <th className="px-3 py-2.5 text-right">Price</th>
              <th className="px-3 py-2.5">Variants</th>
              <th className="px-3 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink/10">
            {products.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 7 : 6} className="px-3 py-8 text-center text-muted-foreground">
                  No products match these filters.
                </td>
              </tr>
            ) : null}
            {products.map((product) => {
              const image = menuImageUrl(product.imagePath);
              return (
                <tr key={product.id} className="transition-colors hover:bg-cream/70">
                  {canManage ? (
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        name="productId"
                        value={product.id}
                        checked={selected.has(product.id)}
                        onChange={() => toggle(product.id)}
                        aria-label={`Select ${product.name}`}
                        className="size-4 accent-ink"
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/menu/products/${product.id}?business=${businessId}`}
                      className="flex items-center gap-2.5 font-medium hover:text-gold-deep"
                    >
                      {image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={image} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                      ) : (
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-ink/5 text-[10px] font-semibold text-muted-foreground">
                          {product.name.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      <span className="max-w-56 truncate">{product.name}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{product.categoryName}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{product.sku ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{minorToDisplay(product.priceMinor)}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {product.variantCount > 0 ? product.variantCount : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    {product.isAvailable ? (
                      <span className="rounded-full bg-emerald-600/10 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        Available
                      </span>
                    ) : (
                      <span className="rounded-full bg-ink/5 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Unavailable
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </form>
  );
}
