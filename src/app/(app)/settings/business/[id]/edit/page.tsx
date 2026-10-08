import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BusinessForm } from "@/modules/business/components/business-form";
import { getOwnedBusiness } from "@/modules/business/queries";

export const metadata: Metadata = { title: "Edit business" };

export default async function EditBusinessPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const business = await getOwnedBusiness(id);

  // Unknown id OR caller is not an owner → indistinguishable, by design.
  if (!business) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link
          href="/settings/business"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Businesses
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{business.name}</h1>
        <p className="text-muted-foreground">
          Business profile · <span className="font-mono text-xs">/{business.slug}</span>
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Business details</CardTitle>
          <CardDescription>
            Slug and status are managed by the platform and cannot be edited here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BusinessForm
            mode="edit"
            businessId={business.id}
            initial={{
              name: business.name,
              restaurantType: business.restaurantType ?? "casual_dining",
              currency: business.currencyCode,
              timezone: business.timezone,
              email: business.email ?? "",
              phone: business.phone ?? "",
              addressLine1: business.addressLine1 ?? "",
              addressLine2: business.addressLine2 ?? "",
              city: business.city ?? "",
              state: business.state ?? "",
              postalCode: business.postalCode ?? "",
              country: business.country ?? "",
              taxNumber: business.taxNumber ?? "",
              logoUrl: business.logoUrl ?? "",
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
