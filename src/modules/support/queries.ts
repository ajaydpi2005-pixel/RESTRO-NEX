import { getSessionUserId } from "@/lib/rbac/enforce";
import { adminRpc } from "@/modules/admin/rpc";
import type { TenantSupportTicket } from "@/modules/admin/types";

/**
 * Tenant support tickets for one business. The RPC returns the business's own
 * messages only, with internal operator notes removed in SQL.
 */
export async function loadTenantSupportTickets(businessId: string): Promise<TenantSupportTicket[]> {
  const actor = await getSessionUserId();
  if (!actor) throw new Error("Please sign in again.");
  return adminRpc<TenantSupportTicket[]>("support_tickets_list", {
    p_actor: actor,
    p_business_id: businessId,
  });
}
