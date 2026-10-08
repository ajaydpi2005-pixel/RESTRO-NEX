import { hasPermission } from "@/lib/rbac/permissions";
import { getManagedBusinesses } from "@/modules/business/queries";

/**
 * Phase 8 — Business resolution for POS + order pages (same pattern as
 * menu/settings: memberships decide the tenant, `?business=` disambiguates).
 */

export interface OrdersBusiness {
  id: string;
  name: string;
  role: string;
}

export async function resolveOrdersBusiness(
  paramBusiness: string | undefined,
): Promise<{ withOrdersView: OrdersBusiness[]; business: OrdersBusiness | undefined }> {
  const businesses = await getManagedBusinesses();
  const withOrdersView = businesses.filter((b) => hasPermission(b.role, "orders.view"));

  const business = paramBusiness
    ? withOrdersView.find((b) => b.id === paramBusiness)
    : withOrdersView.length === 1
      ? withOrdersView[0]
      : undefined;

  return { withOrdersView, business };
}
