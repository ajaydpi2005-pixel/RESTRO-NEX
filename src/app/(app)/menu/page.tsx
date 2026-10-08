import type { Metadata } from "next";
import Link from "next/link";
import {
  BookOpen,
  Image as ImageIcon,
  Layers,
  ListTree,
  Package,
  Plus,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { loadCategoryTree, loadMenuStats } from "@/modules/menu/queries";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Menu" };

export default async function MenuDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string }>;
}) {
  const params = await searchParams;
  const { withMenuView, business } = await resolveMenuBusiness(params.business);
  if (withMenuView.length === 0) return await guardRedirect("/settings");
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath="/menu" />;

  const abilities = await getViewerAbilities(business.id);
  const canManage = abilities.can("menu.manage");
  const [stats, tree] = await Promise.all([loadMenuStats(business.id), loadCategoryTree(business.id)]);
  const query = `?business=${business.id}`;

  const cards = [
    { label: "Products", value: stats.products, note: `${stats.unavailableProducts} unavailable`, href: `/menu/products${query}`, icon: Package },
    { label: "Categories", value: stats.categories, note: "incl. subcategories", href: `/menu/categories${query}`, icon: ListTree },
    { label: "Variants", value: stats.variants, note: "across all products", href: `/menu/products${query}`, icon: Layers },
    { label: "Modifier groups", value: stats.modifierGroups, note: "modifiers & add-ons", href: `/menu/modifiers${query}`, icon: Sparkles },
    { label: "Combos", value: stats.combos, note: "bundled meals", href: `/menu/combos${query}`, icon: BookOpen },
    { label: "Images", value: stats.images, note: "stored in menu-media", href: `/menu/products${query}`, icon: ImageIcon },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Menu</h1>
          <p className="text-muted-foreground">
            {business.name} — the single source of truth for POS, kitchen, ordering and reports.
          </p>
        </div>
        {canManage ? (
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href={`/menu/combos/new${query}`}>New combo</Link>
            </Button>
            <Button asChild>
              <Link href={`/menu/products/new${query}`}>
                <Plus className="size-4" /> New product
              </Link>
            </Button>
          </div>
        ) : (
          <Badge variant="outline">Read-only</Badge>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <Link key={card.label} href={card.href} className="group">
            <Card className="transition-colors group-hover:border-gold/60">
              <CardContent className="flex items-center gap-4 p-5">
                <span className="flex size-10 items-center justify-center rounded-lg bg-ink text-gold">
                  <card.icon className="size-4.5" aria-hidden />
                </span>
                <span>
                  <span className="block font-display text-2xl font-semibold tabular-nums">{card.value}</span>
                  <span className="block text-sm text-muted-foreground">
                    {card.label} · {card.note}
                  </span>
                </span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Category structure</CardTitle>
            <CardDescription>Top-level categories and their subcategories.</CardDescription>
          </div>
          {canManage ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/menu/categories${query}`}>Manage</Link>
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {tree.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No categories yet{canManage ? " — create your first one to start building the menu." : "."}
            </p>
          ) : (
            <ul className="divide-y divide-ink/10">
              {tree.map((category) => (
                <li key={category.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{category.name}</span>
                    {category.children.length > 0 ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {category.children.map((child) => child.name).join(" · ")}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {category.productCount} product{category.productCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
