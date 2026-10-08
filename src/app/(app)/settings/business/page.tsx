import type { Metadata } from "next";
import Link from "next/link";
import { Building2, MapPin, Plus, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getManagedBusinesses } from "@/modules/business/queries";
import { RESTAURANT_TYPE_LABELS } from "@/modules/business/schemas";

export const metadata: Metadata = { title: "Businesses" };

export default async function BusinessListPage() {
  const businesses = await getManagedBusinesses();
  const owned = businesses.filter((b) => b.role === "owner");
  const memberOnly = businesses.filter((b) => b.role !== "owner");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Businesses</h1>
          <p className="text-muted-foreground">
            A business is the company behind your restaurants. Each business runs its own outlets,
            menus and reports.
          </p>
        </div>
        <Button asChild>
          <Link href="/settings/business/new">
            <Plus className="size-4" /> New business
          </Link>
        </Button>
      </div>

      {owned.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl bg-ink text-gold">
              <Building2 className="size-6" />
            </div>
            <div className="space-y-1">
              <CardTitle className="text-base">No businesses yet</CardTitle>
              <CardDescription className="max-w-sm">
                Create your first business to start adding outlets. It takes about a minute —
                name, restaurant type, contact details and tax information.
              </CardDescription>
            </div>
            <Button asChild>
              <Link href="/settings/business/new">
                <Plus className="size-4" /> Create your business
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {owned.map((business) => (
            <Card key={business.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{business.name}</CardTitle>
                    <CardDescription className="font-mono text-xs">/{business.slug}</CardDescription>
                  </div>
                  <Badge variant={business.status === "active" ? "secondary" : "outline"}>
                    {business.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Store className="size-3.5" />
                    {business.outletCount} outlet{business.outletCount === 1 ? "" : "s"}
                  </span>
                  {business.restaurantType ? (
                    <span>{RESTAURANT_TYPE_LABELS[business.restaurantType as keyof typeof RESTAURANT_TYPE_LABELS] ?? business.restaurantType}</span>
                  ) : null}
                  {business.city ? (
                    <span className="flex items-center gap-1.5">
                      <MapPin className="size-3.5" /> {business.city}
                    </span>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/settings/business/${business.id}/edit`}>Edit profile</Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/settings/outlets?business=${business.id}`}>Outlets</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {memberOnly.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Businesses you work in</CardTitle>
            <CardDescription>
              You hold a staff role here — management is handled by the owner.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {memberOnly.map((business) => (
              <Badge key={business.id} variant="outline">
                {business.name} · {business.role.replace(/_/g, " ")}
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
