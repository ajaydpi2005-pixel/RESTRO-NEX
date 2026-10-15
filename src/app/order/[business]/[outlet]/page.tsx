import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Storefront } from "@/modules/online/components/storefront";
import { loadPublicMenu, loadStorefront } from "@/modules/online/public-service";
import { slugSchema } from "@/modules/online/schemas";

/** Phase 17 — public website ordering for one outlet. Anonymous; the server resolves the tenant from the slugs. */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Order online", robots: { index: true, follow: true } };

export default async function OnlineOrderPage({
  params,
}: {
  params: Promise<{ business: string; outlet: string }>;
}) {
  const { business, outlet } = await params;
  if (!slugSchema.safeParse(business).success || !slugSchema.safeParse(outlet).success) notFound();

  const storefront = await loadStorefront(business, outlet);
  if (!storefront) notFound();
  const menu = await loadPublicMenu(storefront.business_id, storefront.outlet_id);

  return (
    <Storefront
      mode="online"
      businessName={storefront.business_name}
      outletName={storefront.outlet_name}
      businessSlug={storefront.business_slug}
      outletSlug={storefront.outlet_slug}
      settings={storefront.settings}
      menu={menu}
    />
  );
}
