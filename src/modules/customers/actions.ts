"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUserId, permissionErrorMessage, requirePermission } from "@/lib/rbac/enforce";
import type { Permission } from "@/lib/rbac/permissions";
import {
  addressSchema,
  applyPromotionSchema,
  couponSchema,
  customerSchema,
  deleteAddressSchema,
  loyaltySettingsSchema,
  pointsAdjustSchema,
  redeemRewardSchema,
  removePromotionSchema,
  rewardSchema,
} from "@/modules/customers/schemas";

/**
 * Phase 15 — customer, loyalty and promotion server actions. Each action checks
 * the session and permission, parses its input, then calls one SQL RPC. The
 * RPCs check the actor again, so a stale page cannot bypass the rules.
 */

export interface CrmActionState {
  ok?: boolean;
  error?: string;
  id?: string;
  duplicate?: boolean;
}

const GENERIC_ERROR = "That did not go through. Refresh the page and try again.";
const SIGN_IN_AGAIN = "Sign in again to keep working.";

function values(formData: FormData): Record<string, FormDataEntryValue | null> {
  return Object.fromEntries(formData.entries());
}

function text(value: FormDataEntryValue | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? GENERIC_ERROR;
}

function userMessage(error: { code?: string; message?: string }): string {
  if (error.code === "P0001" || error.code === "42501") return error.message ?? GENERIC_ERROR;
  return GENERIC_ERROR;
}

async function authorise(
  businessId: string,
  permission: Permission,
  outletId?: string,
): Promise<{ actorId: string } | { error: string }> {
  const actorId = await getSessionUserId();
  if (!actorId) return { error: SIGN_IN_AGAIN };
  try {
    await requirePermission({ businessId, permission, outletId });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }
  return { actorId };
}

async function rpc<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  actorId: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, { p_actor: actorId, ...args });
  if (error) return { ok: false, error: userMessage(error) };
  return { ok: true, data: data as T };
}

export async function saveCustomerAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = customerSchema.safeParse({
    businessId: text(v.businessId),
    id: text(v.id),
    name: text(v.name),
    phone: text(v.phone),
    email: text(v.email),
    notes: text(v.notes),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, "customers.manage");
  if ("error" in auth) return { ok: false, error: auth.error };

  const result = await rpc<string>(
    "customer_save",
    {
      p_business_id: input.businessId,
      p_id: input.id ?? null,
      p_name: input.name,
      p_phone: input.phone,
      p_email: input.email ?? null,
      p_notes: input.notes ?? null,
    },
    auth.actorId,
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, id: typeof result.data === "string" ? result.data : undefined };
}

export async function saveAddressAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = addressSchema.safeParse({
    businessId: text(v.businessId),
    customerId: text(v.customerId),
    id: text(v.id),
    label: text(v.label),
    address: text(v.address),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, "customers.manage");
  if ("error" in auth) return { ok: false, error: auth.error };

  const result = await rpc(
    "customer_address_save",
    {
      p_business_id: input.businessId,
      p_customer_id: input.customerId,
      p_id: input.id ?? null,
      p_label: input.label,
      p_address: input.address,
    },
    auth.actorId,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function deleteAddressAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = deleteAddressSchema.safeParse({ businessId: text(v.businessId), id: text(v.id) });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const auth = await authorise(parsed.data.businessId, "customers.manage");
  if ("error" in auth) return { ok: false, error: auth.error };

  const result = await rpc(
    "customer_address_delete",
    { p_business_id: parsed.data.businessId, p_id: parsed.data.id },
    auth.actorId,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function saveLoyaltySettingsAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = loyaltySettingsSchema.safeParse({
    businessId: text(v.businessId),
    enabled: text(v.enabled) || undefined,
    earnRupeesPerPoint: text(v.earnRupeesPerPoint),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, "customers.manage");
  if ("error" in auth) return { ok: false, error: auth.error };

  const result = await rpc(
    "loyalty_settings_save",
    {
      p_business_id: input.businessId,
      p_enabled: input.enabled,
      p_earn_minor_per_point: input.earnRupeesPerPoint,
    },
    auth.actorId,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function saveRewardAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = rewardSchema.safeParse({
    businessId: text(v.businessId),
    id: text(v.id),
    name: text(v.name),
    pointsCost: text(v.pointsCost),
    discountType: text(v.discountType),
    discountValue: text(v.discountValue),
    maxDiscount: text(v.maxDiscount),
    active: text(v.active) || undefined,
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, "customers.manage");
  if ("error" in auth) return { ok: false, error: auth.error };

  const result = await rpc<string>(
    "loyalty_reward_save",
    {
      p_business_id: input.businessId,
      p_id: input.id ?? null,
      p_name: input.name,
      p_points_cost: input.pointsCost,
      p_discount_type: input.discountType,
      p_discount_value: input.discountValueMinor,
      p_max_discount_minor: input.maxDiscount ?? null,
      p_active: input.active,
    },
    auth.actorId,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function saveCouponAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = couponSchema.safeParse({
    businessId: text(v.businessId),
    id: text(v.id),
    code: text(v.code),
    name: text(v.name),
    discountType: text(v.discountType),
    discountValue: text(v.discountValue),
    maxDiscount: text(v.maxDiscount),
    minSubtotal: text(v.minSubtotal),
    startsOn: text(v.startsOn),
    endsOn: text(v.endsOn),
    usageLimit: text(v.usageLimit),
    perCustomerLimit: text(v.perCustomerLimit),
    active: text(v.active) || undefined,
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, "customers.manage");
  if ("error" in auth) return { ok: false, error: auth.error };

  const result = await rpc<string>(
    "coupon_save",
    {
      p_business_id: input.businessId,
      p_id: input.id ?? null,
      p_code: input.code,
      p_name: input.name,
      p_discount_type: input.discountType,
      p_discount_value: input.discountValueMinor,
      p_max_discount_minor: input.maxDiscount ?? null,
      p_min_subtotal_minor: input.minSubtotal,
      p_starts_on: input.startsOn ?? null,
      p_ends_on: input.endsOn ?? null,
      p_usage_limit: input.usageLimit ?? null,
      p_per_customer_limit: input.perCustomerLimit ?? null,
      p_active: input.active,
    },
    auth.actorId,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function adjustPointsAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = pointsAdjustSchema.safeParse({
    businessId: text(v.businessId),
    customerId: text(v.customerId),
    points: text(v.points),
    reason: text(v.reason),
    clientRef: text(v.clientRef),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, "customers.manage");
  if ("error" in auth) return { ok: false, error: auth.error };

  const result = await rpc<{ duplicate: boolean }>(
    "loyalty_points_adjust",
    {
      p_business_id: input.businessId,
      p_customer_id: input.customerId,
      p_points: input.points,
      p_reason: input.reason,
      p_client_ref: input.clientRef,
    },
    auth.actorId,
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, duplicate: Boolean(result.data?.duplicate) };
}

export async function redeemRewardAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = redeemRewardSchema.safeParse({
    businessId: text(v.businessId),
    customerId: text(v.customerId),
    rewardId: text(v.rewardId),
    clientRef: text(v.clientRef),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, "discounts.apply");
  if ("error" in auth) return { ok: false, error: auth.error };

  const result = await rpc<{ duplicate: boolean; voucher_id: string }>(
    "reward_redeem",
    {
      p_business_id: input.businessId,
      p_customer_id: input.customerId,
      p_reward_id: input.rewardId,
      p_client_ref: input.clientRef,
    },
    auth.actorId,
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, duplicate: Boolean(result.data?.duplicate) };
}

/** Looks up the order's outlet, so orders.manage is checked where the order lives. */
async function orderOutlet(businessId: string, orderId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("orders")
    .select("outlet_id")
    .eq("id", orderId)
    .eq("business_id", businessId)
    .maybeSingle();
  return data?.outlet_id ?? null;
}

export async function applyPromotionAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = applyPromotionSchema.safeParse({
    businessId: text(v.businessId),
    orderId: text(v.orderId),
    code: text(v.code),
    voucherId: text(v.voucherId),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;
  if (!input.code && !input.voucherId)
    return { ok: false, error: "Enter a coupon code or choose a reward." };
  if (input.code && input.voucherId)
    return { ok: false, error: "Apply one coupon or one reward at a time." };

  const outletId = await orderOutlet(input.businessId, input.orderId);
  if (!outletId) return { ok: false, error: "This order no longer exists in this business." };

  const auth = await authorise(input.businessId, "discounts.apply", outletId);
  if ("error" in auth) return { ok: false, error: auth.error };
  const orderAuth = await authorise(input.businessId, "orders.manage", outletId);
  if ("error" in orderAuth) return { ok: false, error: orderAuth.error };

  const result = input.code
    ? await rpc(
        "order_apply_coupon",
        { p_order_id: input.orderId, p_code: input.code },
        auth.actorId,
      )
    : await rpc(
        "order_apply_reward",
        { p_order_id: input.orderId, p_voucher_id: input.voucherId },
        auth.actorId,
      );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function removePromotionAction(
  _prev: CrmActionState | undefined,
  formData: FormData,
): Promise<CrmActionState> {
  const v = values(formData);
  const parsed = removePromotionSchema.safeParse({
    businessId: text(v.businessId),
    orderId: text(v.orderId),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const outletId = await orderOutlet(parsed.data.businessId, parsed.data.orderId);
  if (!outletId) return { ok: false, error: "This order no longer exists in this business." };

  const auth = await authorise(parsed.data.businessId, "discounts.apply", outletId);
  if ("error" in auth) return { ok: false, error: auth.error };
  const orderAuth = await authorise(parsed.data.businessId, "orders.manage", outletId);
  if ("error" in orderAuth) return { ok: false, error: orderAuth.error };

  const result = await rpc(
    "order_remove_promotion",
    { p_order_id: parsed.data.orderId },
    auth.actorId,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
