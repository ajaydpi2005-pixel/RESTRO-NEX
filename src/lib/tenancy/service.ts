import { createClient } from "@/lib/supabase/server";
import {
  MEMBERSHIP_ROLES,
  resolveSelection,
  type BusinessStatus,
  type DirectoryBusiness,
  type DirectoryOutlet,
  type MembershipRole,
  type OutletStatus,
  type ResolvedTenant,
  type TenantDirectory,
} from "@/lib/tenancy/directory";
import { TenancyError } from "@/lib/tenancy/errors";
import { parseTenantSelection } from "@/lib/tenancy/schemas";

/**
 * Server-side tenant resolution (spec §09).
 *
 * Rules enforced here:
 *  - The actor comes from the Supabase session, never from the client.
 *  - The directory is built from RLS-scoped queries, so the database has
 *    already filtered it to the caller's memberships.
 *  - Client-supplied businessId/outletId are shape-checked and then
 *    re-verified against that directory before anything executes.
 */

function assertServerSide() {
  if (typeof window !== "undefined") {
    throw new Error("[RestroNex] Tenant resolution is server-only.");
  }
}

function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

function isBusinessStatus(value: unknown): value is BusinessStatus {
  return value === "active" || value === "suspended" || value === "closed";
}

function isOutletStatus(value: unknown): value is OutletStatus {
  return value === "active" || value === "inactive" || value === "closed";
}

function isUuidString(value: unknown): value is string {
  return typeof value === "string" && value.length === 36;
}

/**
 * Build the caller's tenant directory from the session and RLS-scoped
 * queries. Throws TenancyError("unauthenticated") when no session exists.
 */
export async function getTenantDirectory(): Promise<TenantDirectory> {
  assertServerSide();

  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch {
    throw new TenancyError(
      "supabase-not-configured",
      "Supabase credentials are missing — see docs/SUPABASE_SETUP.md.",
    );
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new TenancyError("unauthenticated", "Sign-in is required to access a tenant.");
  }
  const userId = userData.user.id;

  const { data: membershipRows, error: membershipError } = await supabase
    .from("memberships")
    .select("role, business:businesses(id, name, slug, status)")
    .eq("user_id", userId)
    .eq("status", "active");

  if (membershipError) {
    throw new TenancyError("no-membership", "Tenant lookup failed.");
  }

  const businesses: DirectoryBusiness[] = [];
  for (const row of membershipRows ?? []) {
    const candidate = row as Record<string, unknown>;
    const business = candidate["business"] as Record<string, unknown> | null;
    if (
      !business ||
      !isUuidString(business["id"]) ||
      typeof business["name"] !== "string" ||
      typeof business["slug"] !== "string" ||
      !isBusinessStatus(business["status"]) ||
      !isMembershipRole(candidate["role"])
    ) {
      continue; // Defensive: never surface malformed rows.
    }
    businesses.push({
      id: business["id"],
      name: business["name"],
      slug: business["slug"],
      status: business["status"],
      role: candidate["role"],
    });
  }

  const businessIds = businesses.map((business) => business.id);
  const outlets: DirectoryOutlet[] = [];

  if (businessIds.length > 0) {
    const { data: outletRows, error: outletError } = await supabase
      .from("outlets")
      .select("id, business_id, name, slug, status")
      .in("business_id", businessIds);

    if (outletError) {
      throw new TenancyError("no-membership", "Tenant lookup failed.");
    }

    for (const row of outletRows ?? []) {
      const candidate = row as Record<string, unknown>;
      if (
        !isUuidString(candidate["id"]) ||
        !isUuidString(candidate["business_id"]) ||
        typeof candidate["name"] !== "string" ||
        typeof candidate["slug"] !== "string" ||
        !isOutletStatus(candidate["status"])
      ) {
        continue;
      }
      outlets.push({
        id: candidate["id"],
        businessId: candidate["business_id"],
        name: candidate["name"],
        slug: candidate["slug"],
        status: candidate["status"],
      });
    }
  }

  const { data: accessibleRows } = await supabase.rpc("accessible_outlet_ids");
  const accessibleOutletIds = Array.isArray(accessibleRows)
    ? accessibleRows.filter(isUuidString)
    : [];

  return { userId, businesses, outlets, accessibleOutletIds };
}

/**
 * Validate an untrusted tenant selection from client input and resolve it
 * against the caller's directory. This is THE entry point server actions
 * must use instead of trusting submitted ids (spec §09).
 */
export async function resolveTenantSelection(input: unknown): Promise<ResolvedTenant> {
  assertServerSide();

  const parsed = parseTenantSelection(input);
  if (!parsed.success) {
    throw new TenancyError("invalid-input", "Tenant selection failed validation.");
  }

  const directory = await getTenantDirectory();
  return resolveSelection(directory, parsed.data);
}
