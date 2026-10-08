import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OutletForm } from "@/modules/business/components/outlet-form";
import { getManagedBusinesses } from "@/modules/business/queries";
import { hasPermission } from "@/lib/rbac/permissions";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Add outlet" };

export default async function NewOutletPage({
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

  const business = params.business
    ? owned.find((b) => b.id === params.business)
    : owned.length === 1
      ? owned[0]
      : undefined;

  if (!business) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link
          href={`/settings/outlets?business=${business.id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Outlets · {business.name}
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Add outlet</h1>
        <p className="text-muted-foreground">
          A new outlet inherits {business.name}&apos;s currency and timezone automatically.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outlet details</CardTitle>
          <CardDescription>
            Name and outlet code are required; everything else can be filled in later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OutletForm mode="create" businessId={business.id} />
        </CardContent>
      </Card>
    </div>
  );
}
