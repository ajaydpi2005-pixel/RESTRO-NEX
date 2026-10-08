import { hasPermission } from "@/lib/rbac/permissions";
import { getManagedBusinesses } from "@/modules/business/queries";

/**
 * Phase 7 — Business resolution for menu pages (same pattern as settings:
 * the viewer's memberships decide the tenant; a `?business=` param may
 * disambiguate when the user belongs to several).
 */

export interface MenuBusiness {
  id: string;
  name: string;
  role: string;
}

export async function resolveMenuBusiness(
  paramBusiness: string | undefined,
): Promise<{ withMenuView: MenuBusiness[]; business: MenuBusiness | undefined }> {
  const businesses = await getManagedBusinesses();
  const withMenuView = businesses.filter((b) => hasPermission(b.role, "menu.view"));

  const business = paramBusiness
    ? withMenuView.find((b) => b.id === paramBusiness)
    : withMenuView.length === 1
      ? withMenuView[0]
      : undefined;

  return { withMenuView, business };
}
