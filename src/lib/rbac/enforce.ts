/**
 * RestroNex Phase 5 — server-side authorisation.
 *
 * Every sensitive server operation funnels through requirePermission().
 * The decision path is deliberately explicit:
 *
 *   1. actor identity comes from the Supabase SESSION — never from input
 *   2. the membership is read with the SERVICE client (authoritative,
 *      cannot be filtered away by a clever client)
 *   3. role → permission via the code catalogue (src/lib/rbac/permissions.ts)
 *   4. outlet scope via membership_outlets grants (owner/admin are implicit)
 *
 * Frontend hiding is cosmetic; these checks are the boundary.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  ALL_OUTLETS_ROLES,
  hasPermission,
  isRole,
  permissionsForRole,
  type Permission,
  type Role,
} from "@/lib/rbac/permissions";

export type PermissionErrorCode =
  | "unauthenticated"
  | "no-membership"
  | "forbidden"
  | "outlet-denied";

export class PermissionError extends Error {
  readonly code: PermissionErrorCode;

  constructor(code: PermissionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PermissionError";
  }
}

/** Safe, non-leaking message for action responses. */
export function permissionErrorMessage(error: unknown): string {
  if (error instanceof PermissionError) {
    switch (error.code) {
      case "unauthenticated":
        return "Please sign in again.";
      case "no-membership":
        return "Business not found, or you don't have access to it.";
      case "outlet-denied":
        return "You are not assigned to this outlet.";
      case "forbidden":
        return "You don't have permission to do that.";
    }
  }
  return "You don't have permission to do that.";
}

export interface AuthorisedActor {
  userId: string;
  membershipId: string;
  role: Role;
}

/** Session user id or null. */
export async function getSessionUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * Authoritative membership lookup (service client). Returns the active
 * membership row for (user, business), or null.
 */
export async function findActiveMembership(
  userId: string,
  businessId: string,
): Promise<{ id: string; role: string; status: string } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("memberships")
    .select("id, role, status")
    .eq("user_id", userId)
    .eq("business_id", businessId)
    .eq("status", "active")
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * THE authorisation gate. Throws PermissionError unless the session user
 * holds an active membership in the business whose role grants `permission`
 * (and, when `outletId` is given, an outlet grant as well).
 */
export async function requirePermission(input: {
  businessId: string;
  permission: Permission;
  outletId?: string;
}): Promise<AuthorisedActor> {
  const userId = await getSessionUserId();
  if (!userId) {
    throw new PermissionError("unauthenticated", "Sign-in required.");
  }

  const membership = await findActiveMembership(userId, input.businessId);
  if (!membership || !isRole(membership.role)) {
    throw new PermissionError("no-membership", "No active membership.");
  }

  if (!hasPermission(membership.role, input.permission)) {
    throw new PermissionError("forbidden", `Missing permission ${input.permission}.`);
  }

  if (input.outletId) {
    const implicit = (ALL_OUTLETS_ROLES as readonly string[]).includes(membership.role);
    if (!implicit) {
      const admin = createAdminClient();
      const { data: outlet } = await admin
        .from("outlets")
        .select("id, business_id")
        .eq("id", input.outletId)
        .maybeSingle();
      // Outlet must belong to the SAME business — a grant elsewhere is worthless.
      if (!outlet || outlet.business_id !== input.businessId) {
        throw new PermissionError("outlet-denied", "Outlet not in this business.");
      }
      const { data: grant } = await admin
        .from("membership_outlets")
        .select("outlet_id")
        .eq("membership_id", membership.id)
        .eq("outlet_id", input.outletId)
        .maybeSingle();
      if (!grant) {
        throw new PermissionError("outlet-denied", "No outlet grant.");
      }
    }
  }

  return { userId, membershipId: membership.id, role: membership.role };
}

/** Boolean variant for optional features and UI data assembly. */
export async function canDo(input: {
  businessId: string;
  permission: Permission;
}): Promise<boolean> {
  try {
    await requirePermission(input);
    return true;
  } catch {
    return false;
  }
}

export interface ViewerAbilities {
  userId: string | null;
  role: Role | null;
  permissions: readonly Permission[];
  can: (permission: Permission) => boolean;
}

/**
 * Server-component helper: what the signed-in viewer may do in a business.
 * Returns an empty ability set for non-members — never throws.
 */
export async function getViewerAbilities(businessId: string): Promise<ViewerAbilities> {
  const userId = await getSessionUserId();
  if (!userId) {
    return { userId: null, role: null, permissions: [], can: () => false };
  }
  const membership = await findActiveMembership(userId, businessId);
  if (!membership || !isRole(membership.role)) {
    return { userId, role: null, permissions: [], can: () => false };
  }
  const permissions = [...permissionsForRole(membership.role)];
  return {
    userId,
    role: membership.role,
    permissions,
    can: (permission) => permissions.includes(permission),
  };
}
