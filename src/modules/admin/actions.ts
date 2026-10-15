"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import type { FormActionState } from "@/components/forms/form-bits";
import { AdminAccessError, adminAccessMessage } from "./access";
import { adminRpc, adminServiceMessage } from "./rpc";
import { requireOperator } from "./session";
import {
  businessStatusSchema,
  membershipDeactivateSchema,
  operatorGrantSchema,
  operatorRevokeSchema,
  overrideRpcArgs,
  overrideSchema,
  parsePlanFeatures,
  planSchema,
  subscriptionRpcArgs,
  subscriptionSchema,
  supportNoteSchema,
  supportReplySchema,
  supportUpdateSchema,
} from "./schemas";

/**
 * Super Admin server actions. Every exported function:
 *   1. checks the operator permission with requireOperator (fast, from session)
 *   2. calls one admin_* RPC, which checks the same permission in SQL and
 *      writes the admin audit row in the same transaction
 *   3. returns our own wording only (see rpc.ts)
 *
 * Only async functions are exported. Each one is a server action endpoint.
 */

export type AdminActionState = FormActionState & { message?: string };

function fail(error: unknown): AdminActionState {
  if (error instanceof AdminAccessError) return { ok: false, error: adminAccessMessage(error) };
  if (error instanceof RangeError) return { ok: false, error: error.message };
  return { ok: false, error: adminServiceMessage(error) };
}

function invalid(error: z.ZodError): AdminActionState {
  return { ok: false, error: error.issues[0]?.message ?? "Check the highlighted fields." };
}

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

function refreshAdmin(): void {
  revalidatePath("/admin", "layout");
}

export async function grantOperatorAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = operatorGrantSchema.safeParse({
    email: text(formData, "email"),
    role: text(formData, "role"),
    reason: text(formData, "reason"),
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const op = await requireOperator("operators");
    await adminRpc("admin_operator_grant", {
      p_actor: op.userId,
      p_email: parsed.data.email,
      p_role: parsed.data.role,
      p_reason: parsed.data.reason,
    });
    refreshAdmin();
    return { ok: true, message: "Operator access saved." };
  } catch (error) {
    return fail(error);
  }
}

export async function revokeOperatorAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = operatorRevokeSchema.safeParse({
    userId: text(formData, "userId"),
    reason: text(formData, "reason"),
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const op = await requireOperator("operators");
    await adminRpc("admin_operator_revoke", {
      p_actor: op.userId,
      p_user: parsed.data.userId,
      p_reason: parsed.data.reason,
    });
    refreshAdmin();
    return { ok: true, message: "Operator access revoked." };
  } catch (error) {
    return fail(error);
  }
}

export async function setBusinessStatusAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = businessStatusSchema.safeParse({
    businessId: text(formData, "businessId"),
    status: text(formData, "status"),
    reason: text(formData, "reason"),
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const op = await requireOperator("tenants");
    const result = await adminRpc<{ status: string; memberships_changed: number }>(
      "admin_business_set_status",
      {
        p_actor: op.userId,
        p_business_id: parsed.data.businessId,
        p_status: parsed.data.status,
        p_reason: parsed.data.reason,
      },
    );
    refreshAdmin();
    return {
      ok: true,
      message:
        parsed.data.status === "suspended"
          ? `Business suspended. ${result.memberships_changed} staff access(es) locked.`
          : `Business reactivated. ${result.memberships_changed} staff access(es) restored.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function deactivateMembershipAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = membershipDeactivateSchema.safeParse({
    membershipId: text(formData, "membershipId"),
    reason: text(formData, "reason"),
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const op = await requireOperator("tenants");
    await adminRpc("admin_membership_deactivate", {
      p_actor: op.userId,
      p_membership_id: parsed.data.membershipId,
      p_reason: parsed.data.reason,
    });
    refreshAdmin();
    return { ok: true, message: "Membership deactivated." };
  } catch (error) {
    return fail(error);
  }
}

export async function saveSubscriptionAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = subscriptionSchema.safeParse({
    businessId: text(formData, "businessId"),
    planCode: text(formData, "planCode"),
    status: text(formData, "status"),
    trialEndsOn: text(formData, "trialEndsOn"),
    periodEndsOn: text(formData, "periodEndsOn"),
    reason: text(formData, "reason"),
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const op = await requireOperator("plans");
    await adminRpc("admin_subscription_set", {
      p_actor: op.userId,
      ...subscriptionRpcArgs(parsed.data),
    });
    refreshAdmin();
    return { ok: true, message: "Subscription saved." };
  } catch (error) {
    return fail(error);
  }
}

export async function saveOverrideAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = overrideSchema.safeParse({
    businessId: text(formData, "businessId"),
    featureKey: text(formData, "featureKey"),
    included: text(formData, "included") || "inherit",
    limit: text(formData, "limit"),
    clear: formData.get("clear") === "1",
    reason: text(formData, "reason"),
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const op = await requireOperator("plans");
    const args = overrideRpcArgs(parsed.data);
    await adminRpc("admin_entitlement_override_set", {
      p_actor: op.userId,
      p_business_id: parsed.data.businessId,
      p_feature_key: parsed.data.featureKey,
      p_included: args.p_included,
      p_limit_value: args.p_limit_value,
      p_reason: parsed.data.reason,
    });
    refreshAdmin();
    return { ok: true, message: parsed.data.clear ? "Override removed." : "Override saved." };
  } catch (error) {
    return fail(error);
  }
}

export async function savePlanAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = planSchema.safeParse({
    code: text(formData, "code"),
    name: text(formData, "name"),
    description: text(formData, "description"),
    isActive: formData.get("isActive") === "on",
    reason: text(formData, "reason"),
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const features = parsePlanFeatures(formData);
    const op = await requireOperator("plans");
    await adminRpc("admin_plan_save", {
      p_actor: op.userId,
      p_code: parsed.data.code,
      p_name: parsed.data.name,
      p_description: parsed.data.description,
      p_is_active: parsed.data.isActive,
      p_features: features,
      p_reason: parsed.data.reason,
    });
    refreshAdmin();
    return {
      ok: true,
      message: `Plan ${parsed.data.code} saved. Changes apply to every business on it now.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function supportReplyAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = supportReplySchema.safeParse({
    ticketId: text(formData, "ticketId"),
    body: text(formData, "body"),
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const op = await requireOperator("support");
    await adminRpc("admin_support_reply", {
      p_actor: op.userId,
      p_ticket_id: parsed.data.ticketId,
      p_body: parsed.data.body,
    });
    refreshAdmin();
    return { ok: true, message: "Reply sent. The ticket is now waiting for the customer." };
  } catch (error) {
    return fail(error);
  }
}

export async function supportNoteAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = supportNoteSchema.safeParse({
    ticketId: text(formData, "ticketId"),
    body: text(formData, "body"),
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const op = await requireOperator("support");
    await adminRpc("admin_support_note", {
      p_actor: op.userId,
      p_ticket_id: parsed.data.ticketId,
      p_body: parsed.data.body,
    });
    refreshAdmin();
    return { ok: true, message: "Internal note added. The business cannot see it." };
  } catch (error) {
    return fail(error);
  }
}

export async function supportUpdateAction(
  _previous: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const parsed = supportUpdateSchema.safeParse({
    ticketId: text(formData, "ticketId"),
    status: text(formData, "status"),
    priority: text(formData, "priority"),
    assignToMe: formData.get("assignToMe") === "on",
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const op = await requireOperator("support");
    await adminRpc("admin_support_update", {
      p_actor: op.userId,
      p_ticket_id: parsed.data.ticketId,
      p_status: parsed.data.status,
      p_priority: parsed.data.priority,
      p_assign_to_me: parsed.data.assignToMe,
    });
    refreshAdmin();
    return { ok: true, message: "Ticket updated." };
  } catch (error) {
    return fail(error);
  }
}
