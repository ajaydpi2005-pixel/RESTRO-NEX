import type { Metadata } from "next";
import { guardRedirect } from "@/lib/guarded-redirect";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { resolveKitchenBusiness } from "@/modules/kitchen/context";
import { RoutingManager } from "@/modules/kitchen/components/routing-manager";
import { loadRoutingData } from "@/modules/kitchen/queries";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { loadPosOutlets } from "@/modules/orders/queries";

export const metadata: Metadata = { title: "Kitchen Routing" };

/** Phase 11 — stations and category/item routing. Requires kitchen.manage. */
export default async function KitchenRoutingPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const { eligible, business } = await resolveKitchenBusiness(params.business, "kitchen.manage");
  if (eligible.length === 0) return await guardRedirect("/kitchen");
  if (!business) return <OrdersBusinessPicker businesses={eligible} basePath="/kitchen/routing" />;

  const abilities = await getViewerAbilities(business.id);
  const membership = abilities.userId ? await findActiveMembership(abilities.userId, business.id) : null;
  if (!membership) return await guardRedirect("/kitchen");

  const outlets = await loadPosOutlets(business.id, membership.role, membership.id);
  if (outlets.length === 0) return await guardRedirect("/kitchen");
  const outlet = outlets.find((o) => o.id === params.outlet) ?? outlets[0]!;

  const routing = await loadRoutingData(business.id, outlet.id);
  return (
    <RoutingManager
      outletId={outlet.id}
      outletName={outlet.name}
      initial={routing}
      backHref={`/kitchen?business=${business.id}&outlet=${outlet.id}`}
    />
  );
}
