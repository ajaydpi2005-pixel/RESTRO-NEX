import { createClient } from "@/lib/supabase/server";
import type { OperatingHours } from "@/modules/business/schemas";

/**
 * Phase 4 read paths. All queries run through the session client, so Row
 * Level Security is doing its job; the owner-role filter below is the
 * application layer on top of it.
 */

export interface ManagedBusiness {
  id: string;
  name: string;
  slug: string;
  role: string;
  status: string;
  restaurantType: string | null;
  city: string | null;
  outletCount: number;
}

export interface BusinessDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  logoUrl: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  currencyCode: string;
  timezone: string;
  restaurantType: string | null;
  taxNumber: string | null;
}

export type OrderType = "dine_in" | "takeaway" | "delivery";

export interface OutletDetail {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  code: string | null;
  status: "active" | "inactive" | "closed";
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  orderTypes: OrderType[];
  operatingHours: OperatingHours;
  timezone: string;
  currencyCode: string;
}

/** Businesses the signed-in user belongs to, with outlet counts. */
export async function getManagedBusinesses(): Promise<ManagedBusiness[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: membershipRows, error } = await supabase
    .from("memberships")
    .select(
      "role, business:businesses(id, name, slug, status, restaurant_type, city)",
    )
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (error || !membershipRows) return [];

  const businesses: ManagedBusiness[] = [];
  for (const row of membershipRows) {
    const business = row.business as unknown as Record<string, unknown> | null;
    if (!business || typeof business.id !== "string") continue;
    businesses.push({
      id: business.id,
      name: String(business.name ?? ""),
      slug: String(business.slug ?? ""),
      role: String(row.role),
      status: String(business.status ?? "active"),
      restaurantType: (business.restaurant_type as string | null) ?? null,
      city: (business.city as string | null) ?? null,
      outletCount: 0,
    });
  }

  if (businesses.length > 0) {
    const { data: outletRows } = await supabase
      .from("outlets")
      .select("id, business_id")
      .in(
        "business_id",
        businesses.map((b) => b.id),
      );
    for (const outlet of outletRows ?? []) {
      const match = businesses.find((b) => b.id === outlet.business_id);
      if (match) match.outletCount += 1;
    }
  }

  return businesses;
}

const BUSINESS_COLUMNS =
  "id, name, slug, status, logo_url, email, phone, address_line1, address_line2, city, state, postal_code, country, currency_code, timezone, restaurant_type, tax_number";

const OUTLET_COLUMNS =
  "id, business_id, name, slug, code, status, email, phone, address_line1, address_line2, city, state, postal_code, country, order_types, operating_hours, timezone, currency_code";

/** Full business details when the caller is an active OWNER, else null. */
export async function getOwnedBusiness(businessId: string): Promise<BusinessDetail | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("memberships")
    .select("id")
    .eq("user_id", user.id)
    .eq("business_id", businessId)
    .eq("role", "owner")
    .eq("status", "active")
    .maybeSingle();
  if (!membership) return null;

  const { data: row } = await supabase
    .from("businesses")
    .select(BUSINESS_COLUMNS)
    .eq("id", businessId)
    .maybeSingle();
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    logoUrl: row.logo_url,
    email: row.email,
    phone: row.phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    restaurantType: row.restaurant_type,
    taxNumber: row.tax_number,
  };
}

/** Outlets of a business when the caller is an active OWNER, else null. */
export async function getOwnedOutlets(businessId: string): Promise<OutletDetail[] | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("memberships")
    .select("id")
    .eq("user_id", user.id)
    .eq("business_id", businessId)
    .eq("role", "owner")
    .eq("status", "active")
    .maybeSingle();
  if (!membership) return null;

  const { data: rows, error } = await supabase
    .from("outlets")
    .select(OUTLET_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });
  if (error || !rows) return null;

  return rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    slug: row.slug,
    code: row.code,
    status: row.status,
    email: row.email,
    phone: row.phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    orderTypes: Array.isArray(row.order_types) ? (row.order_types as OrderType[]) : ["dine_in"],
    operatingHours:
      row.operating_hours && typeof row.operating_hours === "object"
        ? (row.operating_hours as unknown as OperatingHours)
        : {},
    timezone: row.timezone,
    currencyCode: row.currency_code,
  }));
}

/** Single outlet for editing, when the caller owns its business. */
export async function getOwnedOutlet(outletId: string): Promise<OutletDetail | null> {
  const supabase = await createClient();
  const { data: row } = await supabase
    .from("outlets")
    .select(OUTLET_COLUMNS)
    .eq("id", outletId)
    .maybeSingle();
  if (!row) return null;
  const outlets = await getOwnedOutlets(row.business_id);
  return outlets?.find((o) => o.id === outletId) ?? null;
}
