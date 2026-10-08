import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { ComboForm } from "@/modules/menu/components/combo-form";
import { DeleteEntityForm } from "@/modules/menu/components/product-delete-form";
import { ImageUploadForm } from "@/modules/menu/components/image-upload-form";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { menuImageUrl } from "@/modules/menu/image";
import { minorToDisplay } from "@/modules/menu/schemas";
import { loadComboDetail, loadProductPicker } from "@/modules/menu/queries";

export const metadata: Metadata = { title: "Edit combo" };

export default async function EditComboPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ business?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { withMenuView, business } = await resolveMenuBusiness(query.business);
  if (withMenuView.length === 0) redirect("/settings");
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath={`/menu/combos/${id}`} />;

  const abilities = await getViewerAbilities(business.id);
  const canManage = abilities.can("menu.manage");
  const [combo, picker] = await Promise.all([loadComboDetail(business.id, id), loadProductPicker(business.id)]);
  if (!combo) notFound();
  const backQuery = `?business=${business.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Link href={`/menu/combos${backQuery}`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink">
            <ChevronLeft className="size-4" aria-hidden /> Combos
          </Link>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{combo.name}</h1>
          <p className="text-muted-foreground">
            {minorToDisplay(combo.priceMinor)} · {combo.items.length} item{combo.items.length === 1 ? "" : "s"}
            {combo.sku ? ` · SKU ${combo.sku}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline">{combo.isVegetarian ? "Vegetarian" : "Non-vegetarian"}</Badge>
          <Badge variant="outline" className={combo.isAvailable ? "border-emerald-600/40 text-emerald-700" : ""}>
            {combo.isAvailable ? "Available" : "Unavailable"}
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Image</CardTitle>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <ImageUploadForm
                  businessId={business.id}
                  targetId={combo.id}
                  kind="combo"
                  imageUrl={menuImageUrl(combo.imagePath)}
                />
              ) : combo.imagePath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={menuImageUrl(combo.imagePath) ?? ""} alt={combo.name} className="h-40 w-full rounded-xl object-cover" />
              ) : (
                <p className="text-sm text-muted-foreground">No image.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contents</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-sm">
                {combo.items.map((item) => (
                  <li key={item.id} className="flex justify-between gap-3">
                    <span>
                      {item.quantity}× {item.productName}
                      {item.variantName ? ` (${item.variantName})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Danger zone</CardTitle>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <DeleteEntityForm businessId={business.id} targetId={combo.id} kind="combo" label={combo.name} />
              ) : (
                <p className="text-sm text-muted-foreground">You need menu management permission.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Combo settings</CardTitle>
            <CardDescription>Items are replaced when you save.</CardDescription>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <ComboForm businessId={business.id} combo={combo} picker={picker} />
            ) : (
              <p className="text-sm text-muted-foreground">Read-only — you have view access to this menu.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
