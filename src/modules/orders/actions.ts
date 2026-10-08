"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSessionUserId,
  permissionErrorMessage,
  requirePermission,
} from "@/lib/rbac/enforce";
import { posOrderPayloadSchema, type PosOrderPayload } from "./schemas";

/**
 * Phase 8 — POS + order server actions.
 *
 * Security model:
 *  - actor = session user, never form input
 *  - businessId/outletId are re-verified server-side (RBAC + outlet grant)
 *  - discounts additionally require the `discounts.apply` permission
 *  - clients send ids + quantities only; the DB RPCs re-resolve prices,
 *    availability, membership and the entire totals computation
 *  - duplicate submissions are absorbed by the client_ref idempotency key
 */

export interface OrderActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  orderId?: string;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";
const SIGN_IN_AGAIN = "Please sign in again.";

function zodFieldErrors(error: import("zod").ZodError): Partial<Record<string, string[]>> {
  const fieldErrors: Partial<Record<string, string[]>> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/** Client camelCase payload → jsonb keys the DB RPCs expect. */
function toDbPayload(payload: PosOrderPayload) {
  return {
    outlet_id: payload.outletId,
    client_ref: payload.clientRef,
    order_type: payload.orderType,
    status: payload.status,
    table_id: payload.tableId ?? null,
    customer_name: payload.customerName,
    customer_phone: payload.customerPhone,
    delivery_address: payload.deliveryAddress,
    notes: payload.notes,
    discount: { type: payload.discount.type, value: payload.discount.value },
    charges: payload.charges.map((c) => ({ name: c.name, amount_minor: c.amountMinor })),
    items: payload.items.map((item) => ({
      item_type: item.itemType,
      product_id: item.productId ?? null,
      combo_id: item.comboId ?? null,
      variant_id: item.variantId ?? null,
      quantity: item.quantity,
      item_notes: item.itemNotes,
      modifiers: item.modifiers.map((m) => ({ modifier_id: m.modifierId, quantity: m.quantity })),
    })),
  };
}

function parsePayload(raw: string): { payload: PosOrderPayload } | { fieldErrors: OrderActionState["fieldErrors"] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { fieldErrors: { form: ["The order could not be read. Refresh and retry."] } };
  }
  const result = posOrderPayloadSchema.safeParse(parsed);
  if (!result.success) {
    return { fieldErrors: zodFieldErrors(result.error) };
  }
  return { payload: result.data };
}

/**
 * Create a new order or re-save an existing open/held order.
 * Form fields: businessId (selector), payload (JSON string).
 */
export async function savePosOrder(formData: FormData): Promise<OrderActionState> {
  const businessId = String(formData.get("businessId") ?? "").trim();
  const raw = String(formData.get("payload") ?? "");
  if (!businessId || !raw) return { error: GENERIC_ERROR };

  const userId = await getSessionUserId();
  if (!userId) return { error: SIGN_IN_AGAIN };

  const parsed = parsePayload(raw);
  if ("fieldErrors" in parsed) return { fieldErrors: parsed.fieldErrors, error: "Please fix the highlighted fields." };
  const { payload } = parsed;

  try {
    // orders.manage + outlet grant for the outlet being operated
    await requirePermission({ businessId, permission: "orders.manage", outletId: payload.outletId });
    // money-affecting input needs the discount permission as well
    if (payload.discount.type !== "none") {
      await requirePermission({ businessId, permission: "discounts.apply" });
    }
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }

  const admin = createAdminClient();
  const dbPayload = toDbPayload(payload);

  try {
    if (payload.orderId) {
      const { data: existing } = await admin
        .from("orders")
        .select("id, business_id, outlet_id")
        .eq("id", payload.orderId)
        .maybeSingle();
      if (!existing || existing.business_id !== businessId) {
        return { error: "This order no longer exists in this business." };
      }
      if (existing.outlet_id !== payload.outletId) {
        return { error: "An order cannot be moved to a different outlet." };
      }
      const { error: rpcError } = await admin.rpc("amend_pos_order", {
        p_actor: userId,
        p_order_id: payload.orderId,
        p_payload: dbPayload,
      });
      if (rpcError) return { error: rpcError.message || GENERIC_ERROR };
      return { ok: true, orderId: payload.orderId };
    }

    const { data: orderId, error: rpcError } = await admin.rpc("create_pos_order", {
      p_actor: userId,
      p_payload: dbPayload,
    });
    if (rpcError || !orderId) return { error: rpcError?.message ?? GENERIC_ERROR };
    return { ok: true, orderId: String(orderId) };
  } catch {
    return { error: GENERIC_ERROR };
  }
}

/**
 * Move an order through the guarded state machine (place / hold / resume /
 * kitchen flow / cancel). The DB enforces the transition map and the
 * payment gate for `completed`.
 * Form fields: businessId, orderId, toStatus, note (optional).
 */
export async function transitionOrder(formData: FormData): Promise<OrderActionState> {
  const businessId = String(formData.get("businessId") ?? "").trim();
  const orderId = String(formData.get("orderId") ?? "").trim();
  const toStatus = String(formData.get("toStatus") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!businessId || !orderId || !toStatus) return { error: GENERIC_ERROR };

  const userId = await getSessionUserId();
  if (!userId) return { error: SIGN_IN_AGAIN };

  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("id, business_id, outlet_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!order || order.business_id !== businessId) {
    return { error: "Order not found in this business." };
  }

  try {
    await requirePermission({ businessId, permission: "orders.manage", outletId: order.outlet_id });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }

  try {
    const { error: rpcError } = await admin.rpc("transition_order_status", {
      p_actor: userId,
      p_order_id: orderId,
      p_to: toStatus,
      p_note: note,
    });
    if (rpcError) return { error: rpcError.message || GENERIC_ERROR };
    return { ok: true, orderId };
  } catch {
    return { error: GENERIC_ERROR };
  }
}
