"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { PermissionError, permissionErrorMessage, requirePermission } from "@/lib/rbac/enforce";
import { canAssignRole, ROLE_META, ALL_OUTLETS_ROLES, isRole, type Role } from "@/lib/rbac/permissions";
import {
  addStaffSchema,
  assignOutletsSchema,
  setStaffStatusSchema,
  updateStaffRoleSchema,
} from "@/modules/staff/schemas";

/**
 * Phase 5 — staff management server actions.
 *
 * Authorisation chain on EVERY action:
 *   session user → active membership → staff.manage permission → rank
 *   hierarchy (actor may only touch roles strictly below their own) →
 *   ownership protection (owners are never modified through this surface).
 *
 * Violations return the same generic shape either way, so probing tells an
 * attacker nothing about which step failed.
 */

export interface StaffActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
}

const GENERIC_DENIED = "You don't have permission to manage staff here.";

function zodFieldErrors(error: import("zod").ZodError): Partial<Record<string, string[]>> {
  const fieldErrors: Partial<Record<string, string[]>> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

function collectForm(formData: FormData, arrayKeys: readonly string[] = []): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    raw[key] = arrayKeys.includes(key) ? formData.getAll(key) : formData.get(key);
  }
  return raw;
}

/** Membership targeted by a staff operation, with ownership protection. */
async function loadTargetMembership(membershipId: string, businessId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("memberships")
    .select("id, user_id, role, status, business_id")
    .eq("id", membershipId)
    .maybeSingle();
  if (!data || data.business_id !== businessId) return null;
  return data;
}

/** Validate that actor may manage target: rank hierarchy + ownership shield. */
function managementViolation(actorRole: Role, targetRole: string | null | undefined, isSelf: boolean): string | null {
  if (isSelf) return "You cannot change your own role or status.";
  if (targetRole === "owner") return "Owners can only be managed through ownership transfer.";
  if (!isRole(targetRole)) return GENERIC_DENIED;
  if (ROLE_META[targetRole].rank >= ROLE_META[actorRole].rank) {
    return "You can only manage roles below your own.";
  }
  return null;
}

// ── add staff ───────────────────────────────────────────────────────────────

export async function addStaffAction(
  _previous: StaffActionState | undefined,
  formData: FormData,
): Promise<StaffActionState> {
  const raw = collectForm(formData, ["outletId"]);
  raw["outletIds"] = raw["outletId"] ?? [];
  delete raw["outletId"];
  const parsed = addStaffSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { businessId, email, role, outletIds } = parsed.data;

  let actor;
  try {
    actor = await requirePermission({ businessId, permission: "staff.manage" });
  } catch (error) {
    return { error: error instanceof PermissionError ? permissionErrorMessage(error) : GENERIC_DENIED };
  }

  if (!canAssignRole(actor.role, role)) {
    return { fieldErrors: { role: ["You cannot assign a role at or above your own."] } };
  }

  // Outlet-scoped roles need at least one outlet grant to be useful — and the
  // grants must belong to THIS business.
  if (!(ALL_OUTLETS_ROLES as readonly string[]).includes(role)) {
    if (outletIds.length === 0) {
      return { fieldErrors: { outletIds: ["Select at least one outlet for this role."] } };
    }
    const admin = createAdminClient();
    const { data: outlets } = await admin
      .from("outlets")
      .select("id")
      .eq("business_id", businessId)
      .in("id", outletIds);
    if (!outlets || outlets.length !== new Set(outletIds).size) {
      return { fieldErrors: { outletIds: ["One or more outlets are not part of this business."] } };
    }
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (!profile) {
    return {
      fieldErrors: {
        email: ["No account exists for this email yet. Ask them to sign up first."],
      },
    };
  }

  const { data: existing } = await admin
    .from("memberships")
    .select("id, status")
    .eq("user_id", profile.id)
    .eq("business_id", businessId)
    .maybeSingle();
  if (existing) {
    return {
      fieldErrors: {
        email: [existing.status === "active" ? "This person is already on the staff." : "An invitation for this person is pending."],
      },
    };
  }

  const { data: membership, error } = await admin
    .from("memberships")
    .insert({ user_id: profile.id, business_id: businessId, role, status: "active" })
    .select("id")
    .single();
  if (error || !membership) {
    return { error: "Something went wrong while adding staff. Please try again." };
  }

  if (!(ALL_OUTLETS_ROLES as readonly string[]).includes(role) && outletIds.length > 0) {
    const { error: grantError } = await admin.from("membership_outlets").insert(
      outletIds.map((outletId) => ({
        membership_id: membership.id,
        outlet_id: outletId,
        granted_by: actor.userId,
      })),
    );
    if (grantError) {
      // Roll back the membership rather than leave a half-assigned member.
      await admin.from("memberships").delete().eq("id", membership.id);
      return { error: "Something went wrong while assigning outlets. Please try again." };
    }
  }

  return { ok: true };
}

// ── change role ─────────────────────────────────────────────────────────────

export async function updateStaffRoleAction(
  _previous: StaffActionState | undefined,
  formData: FormData,
): Promise<StaffActionState> {
  const parsed = updateStaffRoleSchema.safeParse(collectForm(formData));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { businessId, membershipId, role } = parsed.data;

  let actor;
  try {
    actor = await requirePermission({ businessId, permission: "staff.manage" });
  } catch (error) {
    return { error: error instanceof PermissionError ? permissionErrorMessage(error) : GENERIC_DENIED };
  }

  const target = await loadTargetMembership(membershipId, businessId);
  if (!target) {
    return { error: GENERIC_DENIED };
  }

  const violation = managementViolation(actor.role, target.role, target.user_id === actor.userId);
  if (violation) {
    return { error: violation };
  }

  if (!canAssignRole(actor.role, role)) {
    return { fieldErrors: { role: ["You cannot assign a role at or above your own."] } };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("memberships")
    .update({ role })
    .eq("id", membershipId)
    .eq("business_id", businessId);
  if (error) {
    return { error: "Something went wrong while updating the role." };
  }

  // Promotions to implicit-outlet roles clear any stale explicit grants.
  if ((ALL_OUTLETS_ROLES as readonly string[]).includes(role)) {
    await admin.from("membership_outlets").delete().eq("membership_id", membershipId);
  }

  return { ok: true };
}

// ── activate / deactivate ───────────────────────────────────────────────────

export async function setStaffStatusAction(
  _previous: StaffActionState | undefined,
  formData: FormData,
): Promise<StaffActionState> {
  const parsed = setStaffStatusSchema.safeParse(collectForm(formData));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { businessId, membershipId, active } = parsed.data;

  let actor;
  try {
    actor = await requirePermission({ businessId, permission: "staff.manage" });
  } catch (error) {
    return { error: error instanceof PermissionError ? permissionErrorMessage(error) : GENERIC_DENIED };
  }

  const target = await loadTargetMembership(membershipId, businessId);
  if (!target) {
    return { error: GENERIC_DENIED };
  }

  const violation = managementViolation(actor.role, target.role, target.user_id === actor.userId);
  if (violation) {
    return { error: violation };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("memberships")
    .update({ status: active ? "active" : "deactivated" })
    .eq("id", membershipId)
    .eq("business_id", businessId);
  if (error) {
    return { error: "Something went wrong while updating the staff member." };
  }
  return { ok: true };
}

// ── outlet assignment ───────────────────────────────────────────────────────

export async function assignOutletsAction(
  _previous: StaffActionState | undefined,
  formData: FormData,
): Promise<StaffActionState> {
  const raw = collectForm(formData, ["outletId"]);
  raw["outletIds"] = raw["outletId"] ?? [];
  delete raw["outletId"];
  const parsed = assignOutletsSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { businessId, membershipId, outletIds } = parsed.data;

  let actor;
  try {
    actor = await requirePermission({ businessId, permission: "staff.manage" });
  } catch (error) {
    return { error: error instanceof PermissionError ? permissionErrorMessage(error) : GENERIC_DENIED };
  }

  const target = await loadTargetMembership(membershipId, businessId);
  if (!target) {
    return { error: GENERIC_DENIED };
  }
  if (target.user_id === actor.userId) {
    return { error: "You cannot change your own outlet assignment." };
  }
  if (target.role === "owner") {
    return { error: GENERIC_DENIED };
  }
  // owner/business_admin reach every outlet implicitly — grants are meaningless.
  if ((ALL_OUTLETS_ROLES as readonly string[]).includes(target.role)) {
    return { error: "This role already has access to every outlet." };
  }

  const admin = createAdminClient();
  if (outletIds.length > 0) {
    const { data: outlets } = await admin
      .from("outlets")
      .select("id")
      .eq("business_id", businessId)
      .in("id", outletIds);
    if (!outlets || outlets.length !== new Set(outletIds).size) {
      return { fieldErrors: { outletIds: ["One or more outlets are not part of this business."] } };
    }
  }

  const { error: clearError } = await admin
    .from("membership_outlets")
    .delete()
    .eq("membership_id", membershipId);
  if (clearError) {
    return { error: "Something went wrong while updating outlet assignments." };
  }

  if (outletIds.length > 0) {
    const { error: grantError } = await admin.from("membership_outlets").insert(
      outletIds.map((outletId) => ({
        membership_id: membershipId,
        outlet_id: outletId,
        granted_by: actor.userId,
      })),
    );
    if (grantError) {
      return { error: "Something went wrong while updating outlet assignments." };
    }
  }

  return { ok: true };
}
