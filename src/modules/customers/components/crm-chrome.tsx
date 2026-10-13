"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { minorToDisplay } from "@/modules/menu/schemas";
import { SEGMENT_HINTS, SEGMENT_LABELS, type CustomerSegment } from "@/modules/customers/segments";

/** Section tabs for customers. Keeps the business and outlet in the URL. */
export function CrmNav({ businessId, outletId }: { businessId: string; outletId?: string }) {
  const pathname = usePathname() ?? "";
  const tabs = [
    {
      href: "/customers",
      label: "Customers",
      active:
        pathname === "/customers" ||
        (pathname.startsWith("/customers/") && !pathname.startsWith("/customers/loyalty")),
    },
    {
      href: "/customers/loyalty",
      label: "Loyalty & coupons",
      active: pathname.startsWith("/customers/loyalty"),
    },
  ];
  const query = `business=${businessId}${outletId ? `&outlet=${outletId}` : ""}`;
  return (
    <nav aria-label="Customer sections" className="flex flex-wrap gap-1 border-b">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={`${tab.href}?${query}`}
          aria-current={tab.active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            tab.active
              ? "border-gold-deep text-foreground"
              : "text-muted-foreground hover:text-foreground border-transparent",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

export function CrmBusinessPicker({ businesses }: { businesses: { id: string; name: string }[] }) {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Customers</h1>
      <p className="text-muted-foreground">
        Choose the business whose customers and loyalty you want to see.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {businesses.map((business) => (
          <Card key={business.id}>
            <CardHeader>
              <CardTitle className="text-base">{business.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <Link
                href={`/customers?business=${business.id}`}
                className="text-gold-deep text-sm font-medium underline-offset-4 hover:underline"
              >
                Open customers →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function CrmDenied() {
  return (
    <div className="space-y-2">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Customers</h1>
      <p className="text-muted-foreground">
        You don&apos;t have permission to view customers in this business.
      </p>
    </div>
  );
}

export function CrmNoOutlet() {
  return (
    <div className="space-y-2">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Customers</h1>
      <p className="text-muted-foreground">
        You are not assigned to an outlet yet. Ask an owner or admin to give you outlet access.
      </p>
    </div>
  );
}

export function SegmentBadge({ segment }: { segment: CustomerSegment }) {
  const tone =
    segment === "vip"
      ? "bg-gold/20 text-foreground"
      : segment === "lapsed" || segment === "at_risk"
        ? "bg-destructive/10 text-destructive"
        : segment === "no_orders"
          ? "bg-muted text-muted-foreground"
          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return (
    <span
      title={SEGMENT_HINTS[segment]}
      className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", tone)}
    >
      {SEGMENT_LABELS[segment]}
    </span>
  );
}

/** Formats paise as rupees for display, e.g. 12500 → "₹125". */
export function rupees(paise: number): string {
  return `₹${minorToDisplay(paise)}`;
}

/** Human label for a discount rule: "10% off" or "₹50 off". */
export function discountLabel(discountType: "flat" | "percent", value: number): string {
  return discountType === "percent" ? `${value}% off` : `${rupees(value)} off`;
}
