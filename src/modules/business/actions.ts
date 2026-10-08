"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUserId, PermissionError, permissionErrorMessage, requirePermission } from "@/lib/rbac/enforce";
import {
  createBusinessSchema,
  createOutletSchema,
  setOutletStatusSchema,
  slugify,
  updateOutletSchema,
  type CreateBusinessInput,
} from "@/modules/business/schemas";

/**
 * Phase 4/5 — Business + Outlet server actions.
 *
 * Security model (spec §09, §11, §12):
 *  - The actor comes from the Supabase session — never from the request body.
 *  - All writes go through the service-role client; RLS intentionally has no
 *    client INSERT policies for tenants, and authorisation is enforced HERE:
 *    Phase 5's RBAC gate (requirePermission) decides who may do what.
 *  - Every input is zod-validated before touching the database.
 *  - Cross-tenant ids collapse into one generic "not found" message.
 */

export interface BusinessActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  businessId?: string;
  outletId?: string;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";
const NOT_FOUND_OR_FORBIDDEN = "Business not found, or you don't have access to it.";

function zodFieldErrors(error: import("zod").ZodError): Partial<Record<string, string[]>> {
  const fieldErrors: Partial<Record<string, string[]>> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

function denied(error: unknown): BusinessActionState {
  return { error: permissionErrorMessage(error) };
}

function collectForm(formData: FormData, arrayKeys: readonly string[] = []): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    raw[key] = arrayKeys.includes(key) ? formData.getAll(key) : formData.get(key);
  }
  return raw;
}

// ── business ────────────────────────────────────────────────────────────────

export async function createBusinessAction(
  _previous: BusinessActionState | undefined,
  formData: FormData,
): Promise<BusinessActionState> {
  const userId = await getSessionUserId();
  if (!userId) {
    return { error: "Please sign in again." };
  }
  const parsed = createBusinessSchema.safeParse(collectForm(formData));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }
  const input = parsed.data;

  const admin = createAdminClient();
  const { data: businessId, error } = await admin.rpc("create_business", {
    p_owner_id: userId,
    p_name: input.name,
    p_restaurant_type: input.restaurantType,
    p_currency_code: input.currency,
    p_timezone: input.timezone,
    p_email: input.email,
    p_phone: input.phone,
    p_address_line1: input.addressLine1,
    p_address_line2: input.addressLine2,
    p_city: input.city,
    p_state: input.state,
    p_postal_code: input.postalCode,
    p_country: input.country,
    p_tax_number: input.taxNumber,
    p_logo_url: input.logoUrl,
  });

  if (error || !businessId) {
    return { error: GENERIC_ERROR };
  }

  return { ok: true, businessId: String(businessId) };
}

export async function updateBusinessAction(
  _previous: BusinessActionState | undefined,
  formData: FormData,
): Promise<BusinessActionState> {
  const raw = collectForm(formData);
  const businessId = typeof raw["businessId"] === "string" ? raw["businessId"] : "";
  const parsed = createBusinessSchema.safeParse(raw);
  if (!businessId || !parsed.success) {
    return { fieldErrors: { ...(!businessId ? { businessId: ["Missing business."] } : {}), ...(parsed.success ? {} : zodFieldErrors(parsed.error)) } };
  }

  try {
    await requirePermission({ businessId, permission: "settings.manage" });
  } catch (error) {
    if (error instanceof PermissionError && error.code === "forbidden") {
      return { error: "You don't have permission to edit business settings." };
    }
    return denied(error);
  }

  const input: CreateBusinessInput = parsed.data;
  const admin = createAdminClient();
  const { error } = await admin
    .from("businesses")
    .update({
      name: input.name,
      restaurant_type: input.restaurantType,
      currency_code: input.currency,
      timezone: input.timezone,
      email: input.email,
      phone: input.phone,
      address_line1: input.addressLine1,
      address_line2: input.addressLine2,
      city: input.city,
      state: input.state,
      postal_code: input.postalCode,
      country: input.country,
      tax_number: input.taxNumber,
      logo_url: input.logoUrl,
    })
    .eq("id", businessId);

  if (error) {
    return { error: GENERIC_ERROR };
  }
  return { ok: true, businessId };
}

// ── outlets ─────────────────────────────────────────────────────────────────

async function findOutletBusiness(outletId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("outlets")
    .select("business_id")
    .eq("id", outletId)
    .maybeSingle();
  return data?.business_id ?? null;
}

async function insertOutlet(
  businessId: string,
  input: Omit<import("@/modules/business/schemas").CreateOutletInput, "businessId">,
): Promise<{ outletId?: string; fieldErrors?: BusinessActionState["fieldErrors"]; error?: string }> {
  const admin = createAdminClient();

  // New outlets inherit the business-level currency + timezone defaults.
  const { data: business, error: businessError } = await admin
    .from("businesses")
    .select("currency_code, timezone")
    .eq("id", businessId)
    .maybeSingle();
  if (businessError || !business) {
    return { error: NOT_FOUND_OR_FORBIDDEN };
  }

  const baseSlug = slugify(input.name);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const slug =
      attempt === 1 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`;
    const { data, error } = await admin
      .from("outlets")
      .insert({
        business_id: businessId,
        name: input.name,
        slug,
        code: input.code,
        status: "active",
        timezone: business.timezone,
        currency_code: business.currency_code,
        email: input.email,
        phone: input.phone,
        address_line1: input.addressLine1,
        address_line2: input.addressLine2,
        city: input.city,
        state: input.state,
        postal_code: input.postalCode,
        country: input.country,
        order_types: input.orderTypes,
        operating_hours: input.operatingHours,
      })
      .select("id")
      .single();

    if (!error && data) {
      return { outletId: data.id };
    }
    const pgCode = (error as { code?: string } | null)?.code;
    if (pgCode === "23505") {
      const constraint = (error as { details?: string }).details ?? "";
      if (constraint.includes("code")) {
        return { fieldErrors: { code: ["This outlet code is already used in the business."] } };
      }
      if (constraint.includes("slug")) continue; // retry with a new slug
      return { fieldErrors: { name: ["An outlet with these details already exists."] } };
    }
    return { error: GENERIC_ERROR };
  }
  return { error: GENERIC_ERROR };
}

export async function createOutletAction(
  _previous: BusinessActionState | undefined,
  formData: FormData,
): Promise<BusinessActionState> {
  const raw = collectForm(formData, ["orderTypes"]);
  if (typeof raw["operatingHours"] === "string") {
    try {
      raw["operatingHours"] = JSON.parse(raw["operatingHours"] as string);
    } catch {
      raw["operatingHours"] = {};
    }
  }
  const parsed = createOutletSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { businessId, ...input } = parsed.data;

  try {
    await requirePermission({ businessId, permission: "outlets.manage" });
  } catch (error) {
    if (error instanceof PermissionError && error.code === "forbidden") {
      return { error: "You don't have permission to manage outlets." };
    }
    return denied(error);
  }

  const result = await insertOutlet(businessId, input);
  if (result.outletId) {
    return { ok: true, outletId: result.outletId, businessId };
  }
  return { error: result.error, fieldErrors: result.fieldErrors };
}

export async function updateOutletAction(
  _previous: BusinessActionState | undefined,
  formData: FormData,
): Promise<BusinessActionState> {
  const raw = collectForm(formData, ["orderTypes"]);
  if (typeof raw["operatingHours"] === "string") {
    try {
      raw["operatingHours"] = JSON.parse(raw["operatingHours"] as string);
    } catch {
      raw["operatingHours"] = {};
    }
  }
  const parsed = updateOutletSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { outletId, ...input } = parsed.data;

  const businessId = await findOutletBusiness(outletId);
  if (!businessId) {
    return { error: NOT_FOUND_OR_FORBIDDEN };
  }
  try {
    await requirePermission({ businessId, permission: "outlets.manage" });
  } catch (error) {
    if (error instanceof PermissionError && error.code === "forbidden") {
      return { error: "You don't have permission to manage outlets." };
    }
    return denied(error);
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("outlets")
    .update({
      name: input.name,
      code: input.code,
      email: input.email,
      phone: input.phone,
      address_line1: input.addressLine1,
      address_line2: input.addressLine2,
      city: input.city,
      state: input.state,
      postal_code: input.postalCode,
      country: input.country,
      order_types: input.orderTypes,
      operating_hours: input.operatingHours,
    })
    .eq("id", outletId)
    .eq("business_id", businessId);

  if (error) {
    const pgCode = (error as { code?: string } | null)?.code;
    if (pgCode === "23505") {
      return { fieldErrors: { code: ["This outlet code is already used in the business."] } };
    }
    return { error: GENERIC_ERROR };
  }
  return { ok: true, outletId, businessId };
}

export async function setOutletStatusAction(
  _previous: BusinessActionState | undefined,
  formData: FormData,
): Promise<BusinessActionState> {
  const parsed = setOutletStatusSchema.safeParse(collectForm(formData));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { outletId, active } = parsed.data;

  const businessId = await findOutletBusiness(outletId);
  if (!businessId) {
    return { error: NOT_FOUND_OR_FORBIDDEN };
  }
  try {
    await requirePermission({ businessId, permission: "outlets.manage" });
  } catch (error) {
    if (error instanceof PermissionError && error.code === "forbidden") {
      return { error: "You don't have permission to manage outlets." };
    }
    return denied(error);
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("outlets")
    .update({ status: active ? "active" : "inactive" })
    .eq("id", outletId)
    .eq("business_id", businessId);

  if (error) {
    return { error: GENERIC_ERROR };
  }
  return { ok: true, outletId, businessId };
}
