"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  findActiveMembership,
  getSessionUserId,
  permissionErrorMessage,
  requirePermission,
} from "@/lib/rbac/enforce";
import { canAssignRole, isRole } from "@/lib/rbac/permissions";
import { slugify } from "@/modules/business/schemas";
import {
  floorPlanSchema,
  kitchenStationsSchema,
  menuSetupSchema,
  onboardingBusinessSchema,
  onboardingOutletSchema,
  onboardingSettingsSchema,
  restaurantTypeSchema,
  staffInviteSchema,
  taxSettingsSchema,
} from "@/modules/onboarding/schemas";
import { isOnboardingStep, ONBOARDING_STEP_META, stepAfter } from "@/modules/onboarding/steps";

/**
 * Phase 6 — Onboarding server actions.
 *
 * Security model:
 *  - actor = session user, never form input
 *  - the hidden businessId is a SELECTOR only; every action re-verifies the
 *    actor holds an active owner/admin membership before writing
 *  - per-step RBAC permissions are enforced via requirePermission
 *  - all writes go through the service role / SECURITY DEFINER RPCs (the
 *    tables have no client write policies at all)
 */

export interface OnboardingActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  inviteId?: string;
  inviteToken?: string;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";
const SIGN_IN_AGAIN = "Please sign in again.";

function collectForm(formData: FormData, arrayKeys: readonly string[] = []): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    raw[key] = arrayKeys.includes(key) ? formData.getAll(key) : formData.get(key);
  }
  return raw;
}

function zodFieldErrors(error: import("zod").ZodError): Partial<Record<string, string[]>> {
  const fieldErrors: Partial<Record<string, string[]>> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/** Owner/admin membership gate for onboarding writes. */
async function authorizeSetup(
  businessId: string,
): Promise<{ userId: string; role: string } | { error: string }> {
  if (!businessId) return { error: GENERIC_ERROR };
  const userId = await getSessionUserId();
  if (!userId) return { error: SIGN_IN_AGAIN };
  const membership = await findActiveMembership(userId, businessId);
  if (!membership || (membership.role !== "owner" && membership.role !== "business_admin")) {
    return { error: "Only owners and admins can run this business's setup." };
  }
  return { userId, role: membership.role };
}

/** Record step completion + resume point. Best-effort: setup already saved. */
async function advanceProgress(
  userId: string,
  businessId: string,
  completedStep: string | null,
  nextStep: string,
): Promise<void> {
  const admin = createAdminClient();
  await admin.rpc("update_onboarding_progress", {
    p_actor: userId,
    p_business_id: businessId,
    p_current_step: nextStep,
    p_completed_step: completedStep,
    p_finish: false,
  });
}

function readBusinessId(formData: FormData): string {
  const value = formData.get("businessId");
  return typeof value === "string" ? value : "";
}

// ── step 1: create business ─────────────────────────────────────────────────

export async function onboardingCreateBusinessAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { error: SIGN_IN_AGAIN };

  const parsed = onboardingBusinessSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };
  const input = parsed.data;

  const admin = createAdminClient();
  const { data: businessId, error } = await admin.rpc("create_business", {
    p_owner_id: userId,
    p_name: input.name,
    p_restaurant_type: null, // chosen on the next step
    p_currency_code: input.currency,
    p_timezone: input.timezone,
  });
  if (error || !businessId) return { error: GENERIC_ERROR };

  redirect("/onboarding/type");
}

// ── step 2: restaurant type ─────────────────────────────────────────────────

export async function saveRestaurantTypeAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const parsed = restaurantTypeSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  try {
    await requirePermission({ businessId, permission: "settings.manage" });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("businesses")
    .update({ restaurant_type: parsed.data.restaurantType })
    .eq("id", businessId);
  if (error) return { error: GENERIC_ERROR };

  await advanceProgress(auth.userId, businessId, "type", "outlet");
  redirect("/onboarding/outlet");
}

// ── step 3: first outlet ────────────────────────────────────────────────────

export async function onboardingOutletAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const parsed = onboardingOutletSchema.safeParse(collectForm(formData, ["orderTypes"]));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  try {
    await requirePermission({ businessId, permission: "outlets.manage" });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }
  const input = parsed.data;
  const admin = createAdminClient();

  const { data: business } = await admin
    .from("businesses")
    .select("currency_code, timezone")
    .eq("id", businessId)
    .maybeSingle();
  if (!business) return { error: GENERIC_ERROR };

  const baseSlug = slugify(input.name);
  const baseCode = baseSlug.toUpperCase().replace(/-/g, "").slice(0, 10) || "OUT";

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const slug = attempt === 1 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`;
    const code = attempt === 1 ? baseCode : `${baseCode.slice(0, 8)}${attempt}`;
    const { data, error } = await admin
      .from("outlets")
      .insert({
        business_id: businessId,
        name: input.name,
        slug,
        code,
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
        operating_hours: {},
      })
      .select("id")
      .single();

    if (!error && data) {
      await advanceProgress(auth.userId, businessId, "outlet", "settings");
      redirect("/onboarding/settings");
    }
    const pgCode = (error as { code?: string } | null)?.code;
    if (pgCode === "23505") continue; // slug/code collision — retry
    return { error: GENERIC_ERROR };
  }
  return { error: "Could not create the outlet. Try a different name." };
}

// ── step 4: business settings ───────────────────────────────────────────────

export async function saveOnboardingSettingsAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const parsed = onboardingSettingsSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  try {
    await requirePermission({ businessId, permission: "settings.manage" });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }
  const input = parsed.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from("businesses")
    .update({
      name: input.name,
      email: input.email,
      phone: input.phone,
      address_line1: input.addressLine1,
      address_line2: input.addressLine2,
      city: input.city,
      state: input.state,
      postal_code: input.postalCode,
      country: input.country,
      currency_code: input.currency,
      timezone: input.timezone,
    })
    .eq("id", businessId);
  if (error) return { error: GENERIC_ERROR };

  await advanceProgress(auth.userId, businessId, "settings", "tax");
  redirect("/onboarding/tax");
}

// ── step 5: tax settings ────────────────────────────────────────────────────

export async function saveTaxSettingsAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const parsed = taxSettingsSchema.safeParse(
    collectForm(formData, ["rateName", "ratePct", "rateInclusive"]),
  );
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  try {
    await requirePermission({ businessId, permission: "settings.manage" });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }
  const { enabled, taxNumber, invoiceFooter, rates } = parsed.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from("businesses")
    .update({
      tax_number: taxNumber,
      tax_settings: { enabled, rates, invoice_footer: invoiceFooter },
    })
    .eq("id", businessId);
  if (error) return { error: GENERIC_ERROR };

  await advanceProgress(auth.userId, businessId, "tax", "tables");
  redirect("/onboarding/tables");
}

// ── shared: outlet ownership check ──────────────────────────────────────────

async function outletInBusiness(outletId: string, businessId: string): Promise<boolean> {
  if (!outletId) return false;
  const admin = createAdminClient();
  const { data } = await admin
    .from("outlets")
    .select("id, business_id")
    .eq("id", outletId)
    .maybeSingle();
  return data?.business_id === businessId;
}

// ── step 6: tables ──────────────────────────────────────────────────────────

export async function saveFloorPlanAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const outletId = typeof formData.get("outletId") === "string" ? (formData.get("outletId") as string) : "";
  if (!(await outletInBusiness(outletId, businessId))) {
    return { error: "Pick an outlet that belongs to this business." };
  }

  const parsed = floorPlanSchema.safeParse(
    collectForm(formData, ["sectionName", "tableCount", "capacity"]),
  );
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  try {
    await requirePermission({ businessId, permission: "outlets.manage", outletId });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("set_outlet_floor_plan", {
    p_actor: auth.userId,
    p_outlet_id: outletId,
    p_sections: parsed.data.sections,
  });
  if (error) return { error: GENERIC_ERROR };

  await advanceProgress(auth.userId, businessId, "tables", "kitchen");
  redirect("/onboarding/kitchen");
}

// ── step 7: kitchen ─────────────────────────────────────────────────────────

export async function saveKitchenStationsAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const outletId = typeof formData.get("outletId") === "string" ? (formData.get("outletId") as string) : "";
  if (!(await outletInBusiness(outletId, businessId))) {
    return { error: "Pick an outlet that belongs to this business." };
  }

  const parsed = kitchenStationsSchema.safeParse(
    collectForm(formData, ["stationName", "stationDescription"]),
  );
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  try {
    await requirePermission({ businessId, permission: "outlets.manage", outletId });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("set_outlet_kitchen_stations", {
    p_actor: auth.userId,
    p_outlet_id: outletId,
    p_stations: parsed.data.stations,
  });
  if (error) return { error: GENERIC_ERROR };

  await advanceProgress(auth.userId, businessId, "kitchen", "menu");
  redirect("/onboarding/menu");
}

// ── step 8: menu ────────────────────────────────────────────────────────────

export async function saveMenuSetupAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const parsed = menuSetupSchema.safeParse(
    collectForm(formData, ["categoryName", "itemName", "itemPrice", "itemFood", "itemDescription"]),
  );
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  try {
    await requirePermission({ businessId, permission: "menu.manage" });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("set_business_menu", {
    p_actor: auth.userId,
    p_business_id: businessId,
    p_categories: parsed.data.categories,
  });
  if (error) return { error: GENERIC_ERROR };

  await advanceProgress(auth.userId, businessId, "menu", "staff");
  redirect("/onboarding/staff");
}

// ── step 9: staff invites ───────────────────────────────────────────────────

export async function createStaffInviteAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const parsed = staffInviteSchema.safeParse(collectForm(formData, ["outletId"]));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  try {
    await requirePermission({ businessId, permission: "staff.manage" });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }
  const input = parsed.data;

  // The inviter must be senior enough for the role they hand out.
  if (!isRole(auth.role) || !canAssignRole(auth.role, input.role)) {
    return { error: "You can't invite someone to a role above your own." };
  }

  // Outlets must exist in THIS business.
  if (input.outletId.length > 0) {
    const admin = createAdminClient();
    const { data: outlets, error } = await admin
      .from("outlets")
      .select("id")
      .eq("business_id", businessId)
      .in("id", input.outletId);
    if (error || (outlets?.length ?? 0) !== input.outletId.length) {
      return { error: "Pick outlets that belong to this business." };
    }
  }

  const admin = createAdminClient();

  // One pending invite per email — a new invite supersedes the old one.
  if (input.email) {
    await admin
      .from("staff_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .eq("email", input.email)
      .is("accepted_at", null)
      .is("revoked_at", null);
  }

  const token = randomBytes(24).toString("base64url"); // 32 chars
  const expiresAt = new Date(Date.now() + input.expiryDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("staff_invites")
    .insert({
      business_id: businessId,
      email: input.email,
      token,
      role: input.role,
      outlet_ids: input.outletId,
      invited_by: auth.userId,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error || !data) return { error: GENERIC_ERROR };

  return { ok: true, inviteId: data.id, inviteToken: token };
}

export async function revokeStaffInviteAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  try {
    await requirePermission({ businessId, permission: "staff.manage" });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }

  const inviteId = typeof formData.get("inviteId") === "string" ? (formData.get("inviteId") as string) : "";
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("staff_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteId)
    .eq("business_id", businessId)
    .is("accepted_at", null)
    .select("id");
  if (error || !data || data.length === 0) return { error: GENERIC_ERROR };
  return { ok: true };
}

// ── skip + finish ───────────────────────────────────────────────────────────

export async function skipOnboardingStepAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const step = formData.get("step");
  if (!isOnboardingStep(step) || !ONBOARDING_STEP_META[step].skippable) {
    return { error: "This step can't be skipped." };
  }

  const next = stepAfter(step);
  await advanceProgress(auth.userId, businessId, null, next);
  redirect(`/onboarding/${next}`);
}

/**
 * Advance past a step whose work is saved by separate actions (e.g. staff
 * invites): marks the step complete without writing anything else.
 */
export async function continueOnboardingStepAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const step = formData.get("step");
  if (!isOnboardingStep(step) || step === "finish" || step === "business") {
    return { error: GENERIC_ERROR };
  }

  const next = stepAfter(step);
  await advanceProgress(auth.userId, businessId, step, next);
  redirect(`/onboarding/${next}`);
}

export async function finishOnboardingAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const businessId = readBusinessId(formData);
  const auth = await authorizeSetup(businessId);
  if ("error" in auth) return { error: auth.error };

  const admin = createAdminClient();
  const { error } = await admin.rpc("update_onboarding_progress", {
    p_actor: auth.userId,
    p_business_id: businessId,
    p_current_step: "done",
    p_completed_step: "finish",
    p_finish: true,
  });
  if (error) return { error: GENERIC_ERROR };

  redirect("/dashboard?onboarded=1");
}

// ── invite acceptance (used on /invite/[token]) ─────────────────────────────

export async function acceptStaffInviteAction(
  _previous: OnboardingActionState | undefined,
  formData: FormData,
): Promise<OnboardingActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { error: SIGN_IN_AGAIN };

  const token = typeof formData.get("token") === "string" ? (formData.get("token") as string) : "";
  if (!token) return { error: "This invitation link is invalid." };

  const admin = createAdminClient();
  const { error } = await admin.rpc("accept_staff_invite", {
    p_actor: userId,
    p_token: token,
  });
  if (error) {
    const message = (error as { message?: string }).message ?? GENERIC_ERROR;
    // Surface the RPC's human-readable failures; hide everything else.
    if (/invitation|member/i.test(message)) return { error: message };
    return { error: GENERIC_ERROR };
  }

  redirect("/dashboard?joined=1");
}
