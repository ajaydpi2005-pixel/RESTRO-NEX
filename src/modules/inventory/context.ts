import { hasPermission } from "@/lib/rbac/permissions";
import { getManagedBusinesses } from "@/modules/business/queries";

/**
 * Phase 13 — business resolution for inventory pages (same pattern as menu
 * and orders: the viewer's memberships pick the tenant; `?business=` may
 * disambiguate when the user belongs to several).
 */
export interface InventoryBusiness {
  id: string;
  name: string;
  role: string;
}

export async function resolveInventoryBusiness(
  paramBusiness: string | undefined,
  permission: "inventory.view" | "menu.view" = "inventory.view",
): Promise<{ eligible: InventoryBusiness[]; business: InventoryBusiness | undefined }> {
  const businesses = await getManagedBusinesses();
  const eligible = businesses.filter((b) => hasPermission(b.role, permission));
  const business = paramBusiness
    ? eligible.find((b) => b.id === paramBusiness)
    : eligible.length === 1
      ? eligible[0]
      : undefined;
  return { eligible, business };
}
