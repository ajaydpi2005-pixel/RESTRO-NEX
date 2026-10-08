import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { ComboForm } from "@/modules/menu/components/combo-form";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { loadProductPicker } from "@/modules/menu/queries";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "New combo" };

export default async function NewComboPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string }>;
}) {
  const params = await searchParams;
  const { withMenuView, business } = await resolveMenuBusiness(params.business);
  if (withMenuView.length === 0) return await guardRedirect("/settings");
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath="/menu/combos/new" />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("menu.manage")) return await guardRedirect(`/menu/combos?business=${business.id}`);

  const picker = await loadProductPicker(business.id);
  const query = `?business=${business.id}`;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <Link href={`/menu/combos${query}`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink">
          <ChevronLeft className="size-4" aria-hidden /> Combos
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">New combo</h1>
        <p className="text-muted-foreground">Bundle existing products into a single sellable meal.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Combo details</CardTitle>
          <CardDescription>Outlet availability follows the products inside for now.</CardDescription>
        </CardHeader>
        <CardContent>
          <ComboForm businessId={business.id} picker={picker} />
        </CardContent>
      </Card>
    </div>
  );
}
