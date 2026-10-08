import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { ProductsTable } from "@/modules/menu/components/products-table";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { loadCategoryTree, loadProducts, flatCategoryOptions } from "@/modules/menu/queries";
import { productFiltersSchema } from "@/modules/menu/schemas";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; q?: string; category?: string; availability?: string; food?: string }>;
}) {
  const params = await searchParams;
  const { withMenuView, business } = await resolveMenuBusiness(params.business);
  if (withMenuView.length === 0) return await guardRedirect("/settings");
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath="/menu/products" />;

  const abilities = await getViewerAbilities(business.id);
  const canManage = abilities.can("menu.manage");
  const filters = productFiltersSchema.parse({
    q: params.q ?? "",
    category: params.category ?? "",
    availability: params.availability ?? "all",
    food: params.food ?? "all",
  });

  const [products, tree] = await Promise.all([loadProducts(business.id, filters), loadCategoryTree(business.id)]);
  const categoryOptions = flatCategoryOptions(tree);
  const query = `?business=${business.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <Link href={`/menu${query}`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink">
            <ChevronLeft className="size-4" aria-hidden /> Menu dashboard
          </Link>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Products</h1>
          <p className="text-muted-foreground">
            {products.length} product{products.length === 1 ? "" : "s"}
            {filters.q ? ` matching “${filters.q}”` : ""}
          </p>
        </div>
        {canManage ? (
          <Button asChild>
            <Link href={`/menu/products/new${query}`}>
              <Plus className="size-4" /> New product
            </Link>
          </Button>
        ) : null}
      </div>

      <form method="GET" className="grid gap-3 rounded-xl border border-ink/10 bg-white p-4 sm:grid-cols-[1fr_200px_170px_140px_auto]">
        <input type="hidden" name="business" value={business.id} />
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input name="q" defaultValue={filters.q ?? ""} placeholder="Search by name or SKU…" className="pl-9" aria-label="Search products" />
        </div>
        <Select name="category" defaultValue={filters.category ?? ""} aria-label="Filter by category">
          <option value="">All categories</option>
          {categoryOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
        <Select name="availability" defaultValue={filters.availability} aria-label="Filter by availability">
          <option value="all">Any availability</option>
          <option value="available">Available</option>
          <option value="unavailable">Unavailable</option>
        </Select>
        <Select name="food" defaultValue={filters.food} aria-label="Filter by food type">
          <option value="all">All food</option>
          <option value="veg">Veg</option>
          <option value="non_veg">Non-veg</option>
        </Select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      <ProductsTable businessId={business.id} products={products} canManage={canManage} />
    </div>
  );
}
