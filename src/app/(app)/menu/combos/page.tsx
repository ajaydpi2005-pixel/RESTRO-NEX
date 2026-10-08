import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { MenuBusinessPicker } from "@/modules/menu/components/business-gate";
import { resolveMenuBusiness } from "@/modules/menu/context";
import { loadCombos } from "@/modules/menu/queries";
import { minorToDisplay } from "@/modules/menu/schemas";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Combos" };

export default async function CombosPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; q?: string }>;
}) {
  const params = await searchParams;
  const { withMenuView, business } = await resolveMenuBusiness(params.business);
  if (withMenuView.length === 0) return await guardRedirect("/settings");
  if (!business) return <MenuBusinessPicker businesses={withMenuView} basePath="/menu/combos" />;

  const abilities = await getViewerAbilities(business.id);
  const canManage = abilities.can("menu.manage");
  const q = params.q?.trim() || null;
  const combos = await loadCombos(business.id, q);
  const query = `?business=${business.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <Link href={`/menu${query}`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink">
            <ChevronLeft className="size-4" aria-hidden /> Menu dashboard
          </Link>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Combos</h1>
          <p className="text-muted-foreground">Bundled meals sold at a single price.</p>
        </div>
        {canManage ? (
          <Button asChild>
            <Link href={`/menu/combos/new${query}`}>
              <Plus className="size-4" /> New combo
            </Link>
          </Button>
        ) : null}
      </div>

      <form method="GET" className="flex flex-wrap gap-3 rounded-xl border border-ink/10 bg-white p-4">
        <input type="hidden" name="business" value={business.id} />
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input name="q" defaultValue={q ?? ""} placeholder="Search combos…" className="pl-9" aria-label="Search combos" />
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All combos</CardTitle>
          <CardDescription>
            {combos.length} combo{combos.length === 1 ? "" : "s"}
            {q ? ` matching “${q}”` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {combos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No combos yet.</p>
          ) : (
            <ul className="divide-y divide-ink/10">
              {combos.map((combo) => (
                <li key={combo.id} className="flex flex-wrap items-center gap-3 py-3">
                  <Link
                    href={`/menu/combos/${combo.id}${query}`}
                    className="min-w-0 flex-1 text-sm font-medium hover:text-gold-deep"
                  >
                    {combo.name}
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {combo.itemCount} item{combo.itemCount === 1 ? "" : "s"}
                      {combo.sku ? ` · SKU ${combo.sku}` : ""}
                    </span>
                  </Link>
                  <span className="text-sm tabular-nums">{minorToDisplay(combo.priceMinor)}</span>
                  <Badge variant="outline" className={combo.isAvailable ? "border-emerald-600/40 text-emerald-700" : ""}>
                    {combo.isAvailable ? "Available" : "Unavailable"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
