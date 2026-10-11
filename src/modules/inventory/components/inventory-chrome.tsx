"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Section tabs for the inventory module. Keeps the business and outlet in the URL. */
export function InventoryNav({ businessId, outletId }: { businessId: string; outletId?: string }) {
  const pathname = usePathname();
  const query = `?business=${businessId}${outletId ? `&outlet=${outletId}` : ""}`;
  const tabs = [
    { href: "/inventory", label: "Stock", withOutlet: true },
    { href: "/inventory/ingredients", label: "Ingredients", withOutlet: false },
    { href: "/inventory/recipes", label: "Recipes & food cost", withOutlet: false },
    { href: "/inventory/transfers", label: "Transfers", withOutlet: true },
  ];
  return (
    <nav aria-label="Inventory sections" className="flex flex-wrap gap-1 border-b">
      {tabs.map((tab) => {
        const active = tab.href === "/inventory" ? pathname === "/inventory" : pathname?.startsWith(tab.href);
        const href = `${tab.href}${tab.withOutlet ? query : `?business=${businessId}`}`;
        return (
          <Link
            key={tab.href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active ? "border-gold-deep text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Outlet switcher. Plain links, so it works without JavaScript. */
export function OutletTabs({
  businessId,
  outlets,
  activeId,
  path,
}: {
  businessId: string;
  outlets: { id: string; name: string }[];
  activeId: string;
  path: string;
}) {
  if (outlets.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Outlet">
      {outlets.map((o) => (
        <Link
          key={o.id}
          href={`${path}?business=${businessId}&outlet=${o.id}`}
          className={cn(
            "rounded-full border px-3 py-1 text-sm",
            o.id === activeId ? "border-gold-deep bg-muted font-medium" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.name}
        </Link>
      ))}
    </div>
  );
}

export function KpiCard({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "warn" | "ok" }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className={cn("font-display text-2xl font-semibold", tone === "warn" && "text-destructive")}>{value}</div>
        <p className="text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}
