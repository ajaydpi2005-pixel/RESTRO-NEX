import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OutletForm } from "@/modules/business/components/outlet-form";
import { getOwnedOutlet } from "@/modules/business/queries";

export const metadata: Metadata = { title: "Edit outlet" };

export default async function EditOutletPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const outlet = await getOwnedOutlet(id);

  // Unknown id OR not an owner → indistinguishable, by design.
  if (!outlet) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link
          href={`/settings/outlets?business=${outlet.businessId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Outlets
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{outlet.name}</h1>
        <p className="text-muted-foreground">
          Outlet {outlet.code ? <span className="font-mono text-xs">{outlet.code} · </span> : null}
          timezone <span className="font-mono text-xs">{outlet.timezone}</span> · currency{" "}
          <span className="font-mono text-xs">{outlet.currencyCode}</span>
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outlet details</CardTitle>
          <CardDescription>Currency and timezone are set at the business level.</CardDescription>
        </CardHeader>
        <CardContent>
          <OutletForm
            mode="edit"
            businessId={outlet.businessId}
            outletId={outlet.id}
            initial={{
              name: outlet.name,
              code: outlet.code ?? "",
              email: outlet.email ?? "",
              phone: outlet.phone ?? "",
              addressLine1: outlet.addressLine1 ?? "",
              addressLine2: outlet.addressLine2 ?? "",
              city: outlet.city ?? "",
              state: outlet.state ?? "",
              postalCode: outlet.postalCode ?? "",
              country: outlet.country ?? "",
              orderTypes: outlet.orderTypes,
              operatingHours: outlet.operatingHours,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
