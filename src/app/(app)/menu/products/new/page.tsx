import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { CreateProductForm } from "@/modules/menu/components/create-product-form";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { flatCategoryOptions, loadCategoryTree } from "@/modules/menu/queries";

export const metadata: Metadata = { title: "New product" };

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string }>;
}) {
  const params = await searchParams;
  const { withMenuView, business } = await resolveMenuBusiness(params.business);
  if (withMenuView.length === 0) redirect("/settings");
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath="/menu/products/new" />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("menu.manage")) redirect(`/menu/products?business=${business.id}`);

  const tree = await loadCategoryTree(business.id);
  const categories = flatCategoryOptions(tree);
  const query = `?business=${business.id}`;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-1">
        <Link
          href={`/menu/products${query}`}
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden /> Products
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">New product</h1>
        <p className="text-muted-foreground">Add a dish to the menu — you can refine everything afterwards.</p>
      </div>

      {categories.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Create a{" "}
            <Link href={`/menu/categories${query}`} className="font-medium text-gold-deep underline-offset-4 hover:underline">
              category
            </Link>{" "}
            first — every product lives inside one.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Product details</CardTitle>
            <CardDescription>Price is the base price; outlets can override it later.</CardDescription>
          </CardHeader>
          <CardContent>
            <CreateProductForm businessId={business.id} categories={categories} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
