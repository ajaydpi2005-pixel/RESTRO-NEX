import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { ModifierGroupForm } from "@/modules/menu/components/modifier-group-form";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { loadModifierGroupDetail } from "@/modules/menu/queries";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Edit modifier group" };

export default async function EditModifierGroupPage({
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
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath={`/menu/modifiers/${id}`} />;

  const abilities = await getViewerAbilities(business.id);
  const canManage = abilities.can("menu.manage");
  const group = await loadModifierGroupDetail(business.id, id);
  if (!group) notFound();
  const backQuery = `?business=${business.id}`;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <Link
          href={`/menu/modifiers${backQuery}`}
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden /> Modifiers
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{group.name}</h1>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <Badge variant="outline" className="text-xs">
            {group.minSelected > 0 ? `required · min ${group.minSelected}` : "optional add-on"}
          </Badge>
          {group.maxSelected ? <Badge variant="outline" className="text-xs">max {group.maxSelected}</Badge> : null}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Group & options</CardTitle>
          <CardDescription>Removed option rows are deleted when you save.</CardDescription>
        </CardHeader>
        <CardContent>
          {canManage ? (
            <ModifierGroupForm
              businessId={business.id}
              group={{
                id: group.id,
                name: group.name,
                minSelected: group.minSelected,
                maxSelected: group.maxSelected,
                modifiers: group.modifiers,
              }}
            />
          ) : (
            <ul className="space-y-1 text-sm">
              {group.modifiers.map((modifier) => (
                <li key={modifier.id}>{modifier.name}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Used by</CardTitle>
          <CardDescription>Products this group is attached to.</CardDescription>
        </CardHeader>
        <CardContent>
          {group.linkedProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not attached to any product yet — attach it from a product&apos;s page.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {group.linkedProducts.map((product) => (
                <li key={product.id}>
                  <Link
                    href={`/menu/products/${product.id}${backQuery}`}
                    className="text-gold-deep underline-offset-4 hover:underline"
                  >
                    {product.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
