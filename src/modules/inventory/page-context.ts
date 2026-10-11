import { findActiveMembership, getViewerAbilities, type ViewerAbilities } from "@/lib/rbac/enforce";
import { loadPosOutlets } from "@/modules/orders/queries";
import { resolveInventoryBusiness, type InventoryBusiness } from "@/modules/inventory/context";
import type { Permission } from "@/lib/rbac/permissions";

/**
 * Phase 13 — one place that resolves business, membership, permission and
 * the outlet for every inventory page, so the pages cannot drift apart.
 */

export type InventoryPageContext =
  | { kind: "picker"; businesses: InventoryBusiness[] }
  | { kind: "denied" }
  | { kind: "no-outlet" }
  | {
      kind: "ready";
      business: InventoryBusiness;
      abilities: ViewerAbilities;
      userId: string;
      membershipId: string;
      role: string;
      outlets: { id: string; name: string }[];
      outlet: { id: string; name: string };
    };

export async function loadInventoryPageContext(
  params: { business?: string; outlet?: string },
  permission: Permission = "inventory.view",
): Promise<InventoryPageContext | "redirect"> {
  const { eligible, business } = await resolveInventoryBusiness(params.business);
  if (eligible.length === 0) return "redirect";
  if (!business) return { kind: "picker", businesses: eligible };

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can(permission) || !abilities.userId) return { kind: "denied" };

  const membership = await findActiveMembership(abilities.userId, business.id);
  if (!membership) return "redirect";

  const outlets = await loadPosOutlets(business.id, membership.role, membership.id);
  if (outlets.length === 0) return { kind: "no-outlet" };
  const outlet = outlets.find((o) => o.id === params.outlet) ?? outlets[0]!;

  return {
    kind: "ready",
    business,
    abilities,
    userId: abilities.userId,
    membershipId: membership.id,
    role: membership.role,
    outlets,
    outlet,
  };
}
