import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { guardRedirect } from "@/lib/guarded-redirect";
import { IntakeQueue } from "@/modules/online/components/intake-queue";
import { loadIntakeQueue } from "@/modules/online/staff-service";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { resolveOrdersBusiness } from "@/modules/orders/context";
import { loadPosOutlets } from "@/modules/orders/queries";

/** Phase 17 — staff queue for website and QR orders. Viewing needs orders.view; accepting needs orders.manage (checked again per action). */

export const metadata: Metadata = { title: "Online orders" };

export default async function OnlineOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const { withOrdersView, business } = await resolveOrdersBusiness(params.business);
  if (withOrdersView.length === 0) return await guardRedirect("/settings");
  if (!business)
    return <OrdersBusinessPicker businesses={withOrdersView} basePath="/orders/online" />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("orders.view") || !abilities.userId) {
    return (
      <Card>
        <CardContent className="text-muted-foreground p-6 text-sm">
          You don&apos;t have permission to view online orders in this business.
        </CardContent>
      </Card>
    );
  }
  const membership = await findActiveMembership(abilities.userId, business.id);
  if (!membership) return await guardRedirect("/settings");

  const outlets = await loadPosOutlets(business.id, membership.role, membership.id);
  const outletId = outlets.find((o) => o.id === params.outlet)?.id ?? outlets[0]?.id;
  if (!outletId) {
    return <p className="text-muted-foreground text-sm">No outlet is available for you yet.</p>;
  }

  const orders = await loadIntakeQueue(abilities.userId, outletId);

  return (
    <IntakeQueue
      businessId={business.id}
      outletId={outletId}
      outlets={outlets}
      orders={orders}
      canManage={abilities.can("orders.manage")}
      basePath="/orders/online"
    />
  );
}
