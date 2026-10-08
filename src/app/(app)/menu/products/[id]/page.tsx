import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { DeleteEntityForm } from "@/modules/menu/components/product-delete-form";
import { ImageUploadForm } from "@/modules/menu/components/image-upload-form";
import { ModifierAttachSection } from "@/modules/menu/components/modifier-attach-section";
import { OutletOverridesForm } from "@/modules/menu/components/outlet-overrides-form";
import { ProductEditorForm } from "@/modules/menu/components/product-editor-form";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { menuImageUrl } from "@/modules/menu/image";
import { minorToDisplay } from "@/modules/menu/schemas";
import {
  flatCategoryOptions,
  loadCategoryTree,
  loadModifierGroups,
  loadOutlets,
  loadProductDetail,
} from "@/modules/menu/queries";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Edit product" };

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ business?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { withMenuView, business } = await resolveMenuBusiness(query.business);
  if (withMenuView.length === 0) return await guardRedirect("/settings");
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath={`/menu/products/${id}`} />;

  const abilities = await getViewerAbilities(business.id);
  const canManage = abilities.can("menu.manage");

  const [product, tree, outlets, allGroups] = await Promise.all([
    loadProductDetail(business.id, id),
    loadCategoryTree(business.id),
    loadOutlets(business.id),
    loadModifierGroups(business.id),
  ]);
  if (!product) notFound();

  const categories = flatCategoryOptions(tree);
  const attachedIds = new Set(product.modifierGroups.map((group) => group.id));
  const attachable = allGroups.filter((group) => !attachedIds.has(group.id));
  const backHref = `/menu/products?business=${business.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Link href={backHref} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink">
            <ChevronLeft className="size-4" aria-hidden /> Products
          </Link>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{product.name}</h1>
          <p className="text-muted-foreground">
            {product.categoryName} · base price {minorToDisplay(product.priceMinor)}
            {product.sku ? ` · SKU ${product.sku}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline">{product.isVegetarian ? "Vegetarian" : "Non-vegetarian"}</Badge>
          <Badge variant="outline" className={product.isAvailable ? "border-emerald-600/40 text-emerald-700" : ""}>
            {product.isAvailable ? "Available" : "Unavailable"}
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Image</CardTitle>
              <CardDescription>Shown on POS, online ordering and KDS.</CardDescription>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <ImageUploadForm
                  businessId={business.id}
                  targetId={product.id}
                  kind="product"
                  imageUrl={menuImageUrl(product.imagePath)}
                />
              ) : product.imagePath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={menuImageUrl(product.imagePath) ?? ""} alt={product.name} className="h-40 w-full rounded-xl object-cover" />
              ) : (
                <p className="text-sm text-muted-foreground">No image.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Danger zone</CardTitle>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <DeleteEntityForm businessId={business.id} targetId={product.id} kind="product" label={product.name} />
              ) : (
                <p className="text-sm text-muted-foreground">You need menu management permission.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details & variants</CardTitle>
              <CardDescription>
                The base price applies everywhere unless an outlet overrides it. Variant rows replace the current
                variant list when saved.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <ProductEditorForm businessId={business.id} product={product} categories={categories} />
              ) : (
                <p className="text-sm text-muted-foreground">Read-only — you have view access to this menu.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Modifiers & add-ons</CardTitle>
              <CardDescription>
                Groups with a minimum selection are required choices; groups with minimum 0 are optional add-ons.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <ModifierAttachSection
                  businessId={business.id}
                  productId={product.id}
                  attached={product.modifierGroups}
                  attachable={attachable}
                />
              ) : product.modifierGroups.length === 0 ? (
                <p className="text-sm text-muted-foreground">No modifier groups attached.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {product.modifierGroups.map((group) => (
                    <li key={group.id}>
                      {group.name} <span className="text-muted-foreground">({group.optionCount} options)</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outlet pricing & availability</CardTitle>
              <CardDescription>
                Leave the price blank to use the base price. Hiding a product in an outlet keeps it on the menu
                everywhere else.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <OutletOverridesForm
                  businessId={business.id}
                  productId={product.id}
                  basePriceMinor={product.priceMinor}
                  outlets={outlets}
                  overrides={product.overrides}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {product.overrides.length} outlet override{product.overrides.length === 1 ? "" : "s"} configured.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
