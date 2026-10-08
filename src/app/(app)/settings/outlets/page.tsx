import type { Metadata } from "next";
import Link from "next/link";
import { MapPin, Phone, Plus, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getManagedBusinesses, getOwnedOutlets, type OrderType } from "@/modules/business/queries";
import { ORDER_TYPE_LABELS, WEEKDAYS } from "@/modules/business/schemas";
import { hasPermission } from "@/lib/rbac/permissions";
import { OutletStatusToggle } from "@/modules/business/components/outlet-status-toggle";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Outlets" };

function hoursSummary(hours: Record<string, unknown>): string {
  const openDays = WEEKDAYS.filter((day) => {
    const entry = hours[day];
    return entry && typeof entry === "object";
  });
  if (openDays.length === 0) return "Closed every day";
  if (openDays.length === 7) return "Open every day";
  return `Open ${openDays.length} days a week`;
}

export default async function OutletsPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string }>;
}) {
  const params = await searchParams;
  const businesses = await getManagedBusinesses();
  const owned = businesses.filter((b) => hasPermission(b.role, "outlets.manage"));

  if (owned.length === 0) {
    return await guardRedirect("/settings/business");
  }

  // Pick the business: explicit ?business= param if owned, else the only
  // owned business, else a chooser view.
  const requested = params.business;
  const business = requested
    ? owned.find((b) => b.id === requested)
    : owned.length === 1
      ? owned[0]
      : undefined;

  if (!business) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Outlets</h1>
        <p className="text-muted-foreground">Choose the business whose outlets you want to manage.</p>
        <div className="grid gap-4 md:grid-cols-2">
          {owned.map((b) => (
            <Card key={b.id}>
              <CardHeader>
                <CardTitle className="text-base">{b.name}</CardTitle>
                <CardDescription>
                  {b.outletCount} outlet{b.outletCount === 1 ? "" : "s"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/settings/outlets?business=${b.id}`}>Manage outlets</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const outlets = await getOwnedOutlets(business.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-3xl font-semibold tracking-tight">Outlets</h1>
            <Badge variant="outline" className="border-gold/50">{business.name}</Badge>
          </div>
          <p className="text-muted-foreground">
            Every location this business operates — addresses, contact, order types, hours and
            activation.
          </p>
        </div>
        <Button asChild>
          <Link href={`/settings/outlets/new?business=${business.id}`}>
            <Plus className="size-4" /> Add outlet
          </Link>
        </Button>
      </div>

      {!outlets || outlets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl bg-ink text-gold">
              <Store className="size-6" />
            </div>
            <div className="space-y-1">
              <CardTitle className="text-base">No outlets yet</CardTitle>
              <CardDescription className="max-w-sm">
                Add the first location for {business.name} — name, outlet code, address and the
                order types it accepts.
              </CardDescription>
            </div>
            <Button asChild>
              <Link href={`/settings/outlets/new?business=${business.id}`}>
                <Plus className="size-4" /> Add your first outlet
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {outlets.map((outlet) => (
            <Card key={outlet.id} className={outlet.status === "inactive" ? "opacity-70" : undefined}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {outlet.name}
                      {outlet.code ? (
                        <span className="font-mono text-xs font-normal text-muted-foreground">
                          {outlet.code}
                        </span>
                      ) : null}
                    </CardTitle>
                    <CardDescription>
                      {outlet.city ? `${outlet.city} · ` : ""}
                      {outlet.timezone} · {outlet.currencyCode}
                    </CardDescription>
                  </div>
                  <Badge variant={outlet.status === "active" ? "secondary" : "outline"}>
                    {outlet.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Store className="size-3.5" />
                    {outlet.orderTypes
                      .map((t) => ORDER_TYPE_LABELS[t as OrderType] ?? t)
                      .join(" · ")}
                  </span>
                  {outlet.addressLine1 ? (
                    <span className="flex items-center gap-1.5">
                      <MapPin className="size-3.5" /> {outlet.addressLine1}
                    </span>
                  ) : null}
                  {outlet.phone ? (
                    <span className="flex items-center gap-1.5">
                      <Phone className="size-3.5" /> {outlet.phone}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{hoursSummary(outlet.operatingHours)}</p>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/settings/outlets/${outlet.id}/edit`}>Edit</Link>
                  </Button>
                  <OutletStatusToggle outletId={outlet.id} active={outlet.status === "active"} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
