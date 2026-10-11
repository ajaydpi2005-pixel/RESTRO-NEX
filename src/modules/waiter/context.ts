import { getManagedBusinesses } from "@/modules/business/queries";
import { hasPermission } from "@/lib/rbac/permissions";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { loadPosOutlets } from "@/modules/orders/queries";

/**
 * Phase 12 — who may use the waiter app, and in which business and outlet.
 * Membership decides the tenant; the outlet list comes from the same grant
 * rules the POS uses (owners and admins see all, others see granted outlets).
 */

export interface WaiterBusiness {
  id: string;
  name: string;
  role: string;
}

export type WaiterContext =
  | { state: "no-access" }
  | { state: "pick-business"; businesses: WaiterBusiness[] }
  | { state: "no-outlet"; business: WaiterBusiness }
  | {
      state: "ready";
      business: WaiterBusiness;
      outlets: { id: string; name: string }[];
      outlet: { id: string; name: string };
      userId: string;
    };

export async function resolveWaiterContext(params: {
  business?: string;
  outlet?: string;
}): Promise<WaiterContext> {
  const businesses = (await getManagedBusinesses())
    .filter((b) => hasPermission(b.role, "orders.manage"))
    .map((b) => ({ id: b.id, name: b.name, role: b.role }));

  if (businesses.length === 0) return { state: "no-access" };

  const business = params.business
    ? businesses.find((b) => b.id === params.business)
    : businesses.length === 1
      ? businesses[0]
      : undefined;
  if (!business) return { state: "pick-business", businesses };

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.userId) return { state: "no-access" };
  const membership = await findActiveMembership(abilities.userId, business.id);
  if (!membership) return { state: "no-access" };

  const outlets = await loadPosOutlets(business.id, membership.role, membership.id);
  if (outlets.length === 0) return { state: "no-outlet", business };

  const outlet = outlets.find((o) => o.id === params.outlet) ?? outlets[0]!;
  return { state: "ready", business, outlets, outlet, userId: abilities.userId };
}
