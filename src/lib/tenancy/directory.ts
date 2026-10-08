import { TenancyError } from "@/lib/tenancy/errors";
import type { TenantSelection } from "@/lib/tenancy/schemas";

/**
 * Tenant directory: the server-resolved view of everything the current user
 * may touch. Built by getTenantDirectory() from RLS-scoped queries — the
 * database has already filtered it to the caller's memberships.
 *
 * The pure selection logic below is the single authority for resolving
 * client-supplied ids. It is deliberately framework-free so it can be unit
 * tested and reused by server actions, route handlers and middleware.
 */

export const MEMBERSHIP_ROLES = [
  "owner",
  "business_admin",
  "outlet_manager",
  "cashier",
  "waiter",
  "kitchen_staff",
  "inventory_manager",
  "accountant",
] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** Roles with implicit access to every outlet of their business. */
export const ALL_OUTLETS_ROLES: readonly MembershipRole[] = ["owner", "business_admin"];

export type BusinessStatus = "active" | "suspended" | "closed";
export type OutletStatus = "active" | "inactive" | "closed";

export interface DirectoryBusiness {
  id: string;
  name: string;
  slug: string;
  role: MembershipRole;
  status: BusinessStatus;
}

export interface DirectoryOutlet {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  status: OutletStatus;
}

export interface TenantDirectory {
  userId: string;
  businesses: DirectoryBusiness[];
  /** Every outlet visible to the user (business-scoped, for switchers). */
  outlets: DirectoryOutlet[];
  /** Outlets the user may OPERATE in (role + explicit grants). */
  accessibleOutletIds: string[];
}

export interface ResolvedTenant {
  business: DirectoryBusiness;
  outlet: DirectoryOutlet;
}

function activeBusinesses(directory: TenantDirectory): DirectoryBusiness[] {
  return directory.businesses.filter((business) => business.status === "active");
}

/**
 * Resolve the target business. Without an explicit id, an unambiguous single
 * active membership is used; otherwise the caller must choose.
 */
export function selectBusiness(directory: TenantDirectory, businessId?: string): DirectoryBusiness {
  const active = activeBusinesses(directory);

  if (!businessId) {
    if (active.length === 0) {
      throw new TenancyError("no-membership", "No active business membership for this account.");
    }
    const only = active[0];
    if (active.length === 1 && only) {
      return only;
    }
    throw new TenancyError("ambiguous-business", "A businessId is required: multiple memberships exist.");
  }

  const found = active.find((business) => business.id === businessId);
  if (!found) {
    // Same error for "unknown id" and "suspended/closed business": callers
    // must not be able to probe which tenants exist.
    throw new TenancyError("unknown-business", "Business not found or not active for this account.");
  }
  return found;
}

/**
 * Resolve the target outlet inside a business and enforce operate-level
 * access. Visibility alone (being able to see an outlet) never implies
 * operating rights.
 */
export function selectOutlet(
  directory: TenantDirectory,
  business: DirectoryBusiness,
  outletId?: string,
): DirectoryOutlet {
  const businessOutlets = directory.outlets.filter(
    (outlet) => outlet.businessId === business.id && outlet.status === "active",
  );
  const accessible = businessOutlets.filter((outlet) =>
    directory.accessibleOutletIds.includes(outlet.id),
  );

  if (!outletId) {
    if (accessible.length === 0) {
      throw new TenancyError("outlet-not-accessible", "No accessible outlets in this business.");
    }
    const only = accessible[0];
    if (accessible.length === 1 && only) {
      return only;
    }
    throw new TenancyError("ambiguous-outlet", "An outletId is required: multiple outlets are accessible.");
  }

  const inBusiness = businessOutlets.find((outlet) => outlet.id === outletId);
  if (!inBusiness) {
    // Covers unknown ids, inactive outlets and cross-tenant outlet guesses.
    throw new TenancyError("unknown-outlet", "Outlet not found or not active in this business.");
  }
  if (!directory.accessibleOutletIds.includes(outletId)) {
    throw new TenancyError("outlet-not-accessible", "You do not have access to this outlet.");
  }
  return inBusiness;
}

/**
 * Validate a client-supplied tenant selection against the directory.
 * Throws TenancyError with a precise code on any violation.
 */
export function resolveSelection(
  directory: TenantDirectory,
  selection: TenantSelection,
): ResolvedTenant {
  const business = selectBusiness(directory, selection.businessId);
  const outlet = selectOutlet(directory, business, selection.outletId);
  return { business, outlet };
}
