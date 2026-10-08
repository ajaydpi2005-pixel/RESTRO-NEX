import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { CategoryRowActions, CreateCategoryForm } from "@/modules/menu/components/category-forms";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { loadCategoryTree } from "@/modules/menu/queries";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Menu categories" };

export default async function MenuCategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string }>;
}) {
  const params = await searchParams;
  const { withMenuView, business } = await resolveMenuBusiness(params.business);
  if (withMenuView.length === 0) return await guardRedirect("/settings");
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath="/menu/categories" />;

  const abilities = await getViewerAbilities(business.id);
  const canManage = abilities.can("menu.manage");
  const tree = await loadCategoryTree(business.id);
  const query = `?business=${business.id}`;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/menu${query}`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink">
          <ChevronLeft className="size-4" aria-hidden /> Menu dashboard
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Categories</h1>
        <p className="text-muted-foreground">
          Organise the menu with top-level categories and one level of subcategories.
        </p>
      </div>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a category</CardTitle>
            <CardDescription>Pick a parent to create a subcategory.</CardDescription>
          </CardHeader>
          <CardContent>
            <CreateCategoryForm
              businessId={business.id}
              rootCategories={tree.map((node) => ({ id: node.id, name: node.name }))}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Category structure</CardTitle>
          <CardDescription>{tree.length} top-level categories</CardDescription>
        </CardHeader>
        <CardContent>
          {tree.length === 0 ? (
            <p className="text-sm text-muted-foreground">No categories yet.</p>
          ) : (
            <ul className="divide-y divide-ink/10">
              {tree.map((category) => (
                <li key={category.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-medium">{category.name}</span>
                    <Badge variant="outline" className="text-xs">
                      {category.productCount - category.children.reduce((sum, child) => sum + child.productCount, 0)}{" "}
                      products
                    </Badge>
                    {canManage ? (
                      <CategoryRowActions businessId={business.id} categoryId={category.id} name={category.name} />
                    ) : null}
                  </div>
                  {category.children.length > 0 ? (
                    <ul className="mt-2 space-y-2 border-l border-ink/10 pl-5">
                      {category.children.map((child) => (
                        <li key={child.id} className="flex flex-wrap items-center gap-3">
                          <span className="text-sm">{child.name}</span>
                          <Badge variant="outline" className="text-xs">
                            {child.productCount} products
                          </Badge>
                          {canManage ? (
                            <CategoryRowActions businessId={business.id} categoryId={child.id} name={child.name} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
