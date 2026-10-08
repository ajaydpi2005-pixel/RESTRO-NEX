import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUserId } from "@/lib/rbac/enforce";

/**
 * Phase 6 — Onboarding reads.
 *
 * Target-business selection is server-side: of the businesses where the
 * signed-in user is an owner/admin, the one still mid-onboarding wins (most
 * recent first). Clients never choose the tenant.
 */

export interface OnboardingBusiness {
  id: string;
  name: string;
  slug: string;
  restaurantType: string | null;
  currencyCode: string;
  timezone: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  taxNumber: string | null;
  taxSettings: Record<string, unknown>;
}

export interface OnboardingProgress {
  currentStep: string;
  completedSteps: string[];
  completedAt: string | null;
}

export interface OnboardingOutlet {
  id: string;
  name: string;
  code: string | null;
  status: string;
  orderTypes: string[];
}

export interface OnboardingContext {
  userId: string | null;
  role: string | null;
  business: OnboardingBusiness | null;
  progress: OnboardingProgress | null;
}

/** The businesses (id + role) where this user can run onboarding. */
export async function getManageableBusinessIds(
  userId: string,
): Promise<{ businessId: string; role: string }[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("memberships")
    .select("business_id, role, status")
    .eq("user_id", userId)
    .in("role", ["owner", "business_admin"])
    .eq("status", "active");
  if (error || !data) return [];
  return data.map((row) => ({ businessId: row.business_id, role: row.role }));
}

async function loadBusiness(businessId: string): Promise<OnboardingBusiness | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("businesses")
    .select(
      "id, name, slug, restaurant_type, currency_code, timezone, email, phone, address_line1, address_line2, city, state, postal_code, country, tax_number, tax_settings",
    )
    .eq("id", businessId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    restaurantType: data.restaurant_type,
    currencyCode: data.currency_code,
    timezone: data.timezone,
    email: data.email,
    phone: data.phone,
    addressLine1: data.address_line1,
    addressLine2: data.address_line2,
    city: data.city,
    state: data.state,
    postalCode: data.postal_code,
    country: data.country,
    taxNumber: data.tax_number,
    taxSettings: (data.tax_settings ?? {}) as Record<string, unknown>,
  };
}

export async function loadProgress(businessId: string): Promise<OnboardingProgress | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("onboarding_progress")
    .select("current_step, completed_steps, completed_at")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    currentStep: data.current_step,
    completedSteps: data.completed_steps ?? [],
    completedAt: data.completed_at,
  };
}

/**
 * Resolve the wizard context for the signed-in user. `business` is null when
 * the user owns nothing yet (they start at the create-business step).
 */
export async function getOnboardingContext(): Promise<OnboardingContext> {
  const userId = await getSessionUserId();
  if (!userId) {
    return { userId: null, role: null, business: null, progress: null };
  }

  const candidates = await getManageableBusinessIds(userId);
  if (candidates.length === 0) {
    return { userId, role: null, business: null, progress: null };
  }

  // Most recent first: memberships are created when the business is.
  for (const candidate of candidates) {
    const progress = await loadProgress(candidate.businessId);
    if (progress && progress.completedAt === null) {
      const business = await loadBusiness(candidate.businessId);
      if (business) {
        return { userId, role: candidate.role, business, progress };
      }
    }
  }

  // Everything already onboarded → surface the most recent business anyway
  // (the route redirects to the dashboard, but links may still render it).
  const latest = candidates[0];
  if (!latest) return { userId, role: null, business: null, progress: null };
  const business = await loadBusiness(latest.businessId);
  const progress = await loadProgress(latest.businessId);
  return { userId, role: latest.role, business, progress };
}

// ── step data ───────────────────────────────────────────────────────────────

export async function loadOutlets(businessId: string): Promise<OnboardingOutlet[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("outlets")
    .select("id, name, code, status, order_types")
    .eq("business_id", businessId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    orderTypes: row.order_types ?? [],
  }));
}

export interface FloorPlanSection {
  id: string;
  name: string;
  tables: { id: string; label: string; capacity: number }[];
}

export async function loadFloorPlan(outletId: string): Promise<FloorPlanSection[]> {
  const admin = createAdminClient();
  const { data: sections, error } = await admin
    .from("dining_sections")
    .select("id, name, sort_order")
    .eq("outlet_id", outletId)
    .order("sort_order", { ascending: true });
  if (error || !sections) return [];
  const { data: tables } = await admin
    .from("dining_tables")
    .select("id, label, capacity, section_id, sort_order")
    .eq("outlet_id", outletId)
    .order("sort_order", { ascending: true });
  return sections.map((section) => ({
    id: section.id,
    name: section.name,
    tables: (tables ?? [])
      .filter((table) => table.section_id === section.id)
      .map((table) => ({ id: table.id, label: table.label, capacity: table.capacity })),
  }));
}

export interface KitchenStationRow {
  id: string;
  name: string;
  description: string | null;
}

export async function loadKitchenStations(outletId: string): Promise<KitchenStationRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kitchen_stations")
    .select("id, name, description")
    .eq("outlet_id", outletId)
    .order("sort_order", { ascending: true });
  if (error || !data) return [];
  return data;
}

export interface MenuCategoryRow {
  id: string;
  name: string;
  items: {
    id: string;
    name: string;
    description: string | null;
    priceMinor: number;
    isVegetarian: boolean;
  }[];
}

export async function loadMenu(businessId: string): Promise<MenuCategoryRow[]> {
  const admin = createAdminClient();
  const { data: categories, error } = await admin
    .from("menu_categories")
    .select("id, name, sort_order")
    .eq("business_id", businessId)
    .order("sort_order", { ascending: true });
  if (error || !categories) return [];
  const { data: items } = await admin
    .from("menu_items")
    .select("id, name, description, price_minor, is_vegetarian, category_id, sort_order")
    .eq("business_id", businessId)
    .order("sort_order", { ascending: true });
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    items: (items ?? [])
      .filter((item) => item.category_id === category.id)
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        priceMinor: Number(item.price_minor),
        isVegetarian: item.is_vegetarian,
      })),
  }));
}

export interface PendingInvite {
  id: string;
  email: string | null;
  role: string;
  outletIds: string[];
  outletNames: string[];
  expiresAt: string;
  createdAt: string;
}

export async function loadPendingInvites(businessId: string): Promise<PendingInvite[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("staff_invites")
    .select("id, email, role, outlet_ids, expires_at, created_at, accepted_at, revoked_at")
    .eq("business_id", businessId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  const outlets = await loadOutlets(businessId);
  const now = Date.now();
  return data
    .filter((row) => new Date(row.expires_at).getTime() > now)
    .map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      outletIds: (row.outlet_ids ?? []) as string[],
      outletNames: ((row.outlet_ids ?? []) as string[]).map(
        (id) => outlets.find((outlet) => outlet.id === id)?.name ?? "unknown outlet",
      ),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
}

export interface OnboardingCounts {
  outlets: number;
  tables: number;
  kitchenStations: number;
  menuItems: number;
  pendingInvites: number;
}

export async function loadOnboardingCounts(
  businessId: string,
  outlets: OnboardingOutlet[],
): Promise<OnboardingCounts> {
  const admin = createAdminClient();
  const countOf = async (table: string, column: string, value: string) => {
    const { count } = await admin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq(column, value);
    return count ?? 0;
  };
  let tables = 0;
  let stations = 0;
  for (const outlet of outlets) {
    tables += await countOf("dining_tables", "outlet_id", outlet.id);
    stations += await countOf("kitchen_stations", "outlet_id", outlet.id);
  }
  const menuItems = await countOf("menu_items", "business_id", businessId);
  const invites = await loadPendingInvites(businessId);
  return {
    outlets: outlets.length,
    tables,
    kitchenStations: stations,
    menuItems,
    pendingInvites: invites.length,
  };
}
