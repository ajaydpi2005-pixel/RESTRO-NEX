"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSessionUserId,
  permissionErrorMessage,
  requirePermission,
} from "@/lib/rbac/enforce";
import { toDbSubmitPayload, waiterSubmitSchema } from "@/modules/waiter/schemas";

/**
 * Phase 12 — waiter server actions.
 *
 * Every action re-checks the session, the business membership, and the
 * outlet grant with `orders.manage` before touching the database. The RPCs
 * re-check the same rules inside SQL and never accept prices, discounts or
 * charges from the client.
 */

export interface WaiterActionResult {
  ok: boolean;
  error?: string;
  orderId?: string;
  billRequestedAt?: string;
}

const GENERIC_ERROR = "That did not go through. Refresh the table and try again.";

export async function submitWaiterOrderAction(
  businessId: string,
  rawPayload: string,
): Promise<WaiterActionResult> {
  if (!businessId || !rawPayload) return { ok: false, error: GENERIC_ERROR };

  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Sign in again to keep ordering." };

  let json: unknown;
  try {
    json = JSON.parse(rawPayload);
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }

  const parsed = waiterSubmitSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
  }
  const input = parsed.data;

  try {
    await requirePermission({ businessId, permission: "orders.manage", outletId: input.outletId });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("waiter_submit_order", {
    p_actor: userId,
    p_payload: toDbSubmitPayload(input),
    p_send: input.send,
  });
  if (error) {
    return { ok: false, error: error.message || GENERIC_ERROR };
  }
  return { ok: true, orderId: String(data) };
}

export async function requestBillAction(
  businessId: string,
  orderId: string,
): Promise<WaiterActionResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Sign in again to continue." };

  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("outlet_id, business_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!order || order.business_id !== businessId) {
    return { ok: false, error: "Order not found." };
  }

  try {
    await requirePermission({ businessId, permission: "orders.manage", outletId: order.outlet_id });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }

  const { data, error } = await admin.rpc("waiter_request_bill", {
    p_actor: userId,
    p_order_id: orderId,
  });
  if (error) {
    return { ok: false, error: error.message || GENERIC_ERROR };
  }
  return { ok: true, orderId, billRequestedAt: String(data) };
}
