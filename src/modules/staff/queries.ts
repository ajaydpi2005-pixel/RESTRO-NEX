import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/rbac/enforce";
import type { Role } from "@/lib/rbac/permissions";

export interface StaffMember {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: Role;
  status: string;
  outletIds: string[];
  createdAt: string;
}

/**
 * Staff roster for the staff-management UI. Requires `staff.view` — throws
 * PermissionError otherwise, so pages can render a denial state.
 */
export async function getStaffList(businessId: string): Promise<StaffMember[]> {
  await requirePermission({ businessId, permission: "staff.view" });

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("memberships")
    .select("id, user_id, role, status, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });
  if (error || !rows) return [];

  const userIds = rows.map((r) => r.user_id);
  const { data: profiles } = await admin
    .from("user_profiles")
    .select("id, email, full_name")
    .in("id", userIds);
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  const { data: grants } = await admin
    .from("membership_outlets")
    .select("membership_id, outlet_id")
    .in(
      "membership_id",
      rows.map((r) => r.id),
    );
  const grantsByMembership = new Map<string, string[]>();
  for (const grant of grants ?? []) {
    const list = grantsByMembership.get(grant.membership_id) ?? [];
    list.push(grant.outlet_id);
    grantsByMembership.set(grant.membership_id, list);
  }

  return rows.map((row) => {
    const profile = profileById.get(row.user_id);
    return {
      membershipId: row.id,
      userId: row.user_id,
      email: profile?.email ?? "",
      fullName: profile?.full_name ?? null,
      role: row.role as Role,
      status: row.status,
      outletIds: grantsByMembership.get(row.id) ?? [],
      createdAt: row.created_at,
    };
  });
}
