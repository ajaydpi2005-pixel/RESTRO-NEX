import { hasPermission, type Permission } from "@/lib/rbac/permissions";
import { getManagedBusinesses } from "@/modules/business/queries";

/**
 * Phase 11 — business resolution for the KDS pages (same pattern as POS and
 * floor: memberships decide the tenant, `?business=` disambiguates).
 */

export interface KitchenBusiness {
  id: string;
  name: string;
  role: string;
}

export async function resolveKitchenBusiness(
  paramBusiness: string | undefined,
  permission: Permission = "kitchen.view",
): Promise<{ eligible: KitchenBusiness[]; business: KitchenBusiness | undefined }> {
  const businesses = await getManagedBusinesses();
  const eligible = businesses.filter((b) => hasPermission(b.role, permission));

  const business = paramBusiness
    ? eligible.find((b) => b.id === paramBusiness)
    : eligible.length === 1
      ? eligible[0]
      : undefined;

  return { eligible, business };
}
