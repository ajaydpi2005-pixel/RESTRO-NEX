import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { ModifierGroupDelete } from "@/modules/menu/components/modifier-group-delete";
import { ModifierGroupForm } from "@/modules/menu/components/modifier-group-form";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { loadModifierGroups } from "@/modules/menu/queries";

export const metadata: Metadata = { title: "Modifiers & add-ons" };

export default async function ModifiersPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string }>;
}) {
  const params = await searchParams;
  const { withMenuView, business } = await resolveMenuBusiness(params.business);
  if (withMenuView.length === 0) redirect("/settings");
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath="/menu/modifiers" />;

  const abilities = await getViewerAbilities(business.id);
  const canManage = abilities.can("menu.manage");
  const groups = await loadModifierGroups(business.id);
  const query = `?business=${business.id}`;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/menu${query}`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink">
          <ChevronLeft className="size-4" aria-hidden /> Menu dashboard
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Modifiers & add-ons</h1>
        <p className="text-muted-foreground">
          Reusable option groups: required choices (min ≥ 1) and optional add-ons (min = 0), attachable to any product.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Groups</CardTitle>
          <CardDescription>{groups.length} modifier group{groups.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No groups yet — create the first one below.</p>
          ) : (
            <ul className="divide-y divide-ink/10">
              {groups.map((group) => (
                <li key={group.id} className="flex flex-wrap items-center gap-3 py-3">
                  <Link
                    href={`/menu/modifiers/${group.id}${query}`}
                    className="min-w-0 flex-1 text-sm font-medium hover:text-gold-deep"
                  >
                    {group.name}
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {group.optionCount} option{group.optionCount === 1 ? "" : "s"} · attached to{" "}
                      {group.productCount} product{group.productCount === 1 ? "" : "s"}
                    </span>
                  </Link>
                  <Badge variant="outline" className="text-xs">
                    {group.minSelected > 0
                      ? `min ${group.minSelected}${group.maxSelected ? ` · max ${group.maxSelected}` : ""}`
                      : group.maxSelected
                        ? `add-on · up to ${group.maxSelected}`
                        : "add-on"}
                  </Badge>
                  {canManage ? <ModifierGroupDelete businessId={business.id} groupId={group.id} name={group.name} /> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New modifier group</CardTitle>
            <CardDescription>Set minimum selections to 0 to make it an optional add-on.</CardDescription>
          </CardHeader>
          <CardContent>
            <ModifierGroupForm businessId={business.id} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
