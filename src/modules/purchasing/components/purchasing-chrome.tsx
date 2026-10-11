"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Section tabs for purchasing. Keeps the business and outlet in the URL. */
export function PurchasingNav({ businessId, outletId }: { businessId: string; outletId?: string }) {
  const pathname = usePathname();
  const outletQuery = `&outlet=${outletId ?? ""}`;
  const tabs = [
    { href: "/purchasing", label: "Overview", outlet: true },
    { href: "/purchasing/suppliers", label: "Suppliers", outlet: false },
    { href: "/purchasing/orders", label: "Orders & receiving", outlet: true },
    { href: "/purchasing/invoices", label: "Supplier invoices", outlet: true },
    { href: "/purchasing/reports", label: "Reports", outlet: true },
  ];
  return (
    <nav aria-label="Purchasing sections" className="flex flex-wrap gap-1 border-b">
      {tabs.map((tab) => {
        const active = tab.href === "/purchasing" ? pathname === "/purchasing" : pathname?.startsWith(tab.href);
        const href = `${tab.href}?business=${businessId}${tab.outlet && outletId ? outletQuery : ""}`;
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

export function PurchasingBusinessPicker({ businesses }: { businesses: { id: string; name: string }[] }) {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Purchasing</h1>
      <p className="text-muted-foreground">Choose the business whose suppliers and purchases you want to see.</p>
      <div className="grid gap-4 md:grid-cols-2">
        {businesses.map((business) => (
          <Card key={business.id}>
            <CardHeader>
              <CardTitle className="text-base">{business.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <Link
                href={`/purchasing?business=${business.id}`}
                className="text-sm font-medium text-gold-deep underline-offset-4 hover:underline"
              >
                Open purchasing →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function PurchasingDenied() {
  return (
    <div className="space-y-2">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Purchasing</h1>
      <p className="text-muted-foreground">You don&apos;t have permission to view purchasing in this business.</p>
    </div>
  );
}

export function PurchasingNoOutlet() {
  return (
    <div className="space-y-2">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Purchasing</h1>
      <p className="text-muted-foreground">
        You are not assigned to an outlet yet. Ask an owner or admin to give you outlet access.
      </p>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "received"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : status === "cancelled"
        ? "bg-muted text-muted-foreground"
        : status === "draft"
          ? "bg-muted text-foreground"
          : "bg-gold/15 text-foreground";
  const label =
    { draft: "Draft", sent: "Sent", partially_received: "Part received", received: "Received", cancelled: "Cancelled" }[
      status
    ] ?? status;
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", tone)}>{label}</span>;
}

/** Shown to users who can view purchasing but not change it. */
export function PurchasingManageRequired({ what }: { what: string }) {
  return (
    <div className="space-y-2">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Purchasing</h1>
      <p className="text-muted-foreground">{what} needs purchasing management access in this business.</p>
    </div>
  );
}
