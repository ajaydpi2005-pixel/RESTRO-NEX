import { createAdminClient } from "@/lib/supabase/admin";
import type { CheckoutInput } from "./schemas";
import { sha256Hex } from "./security";
import type {
  OrderingSettings,
  PublicMenu,
  PublicOrderStatus,
  QrContext,
  StorefrontContext,
} from "./types";

/**
 * Phase 17 — server-side access for public (anonymous) customers.
 *
 * Every function here calls a public_* database function through the service
 * role, after the caller has validated its input. The database functions take
 * the tenant, outlet and QR identity from the arguments we pass, and those
 * arguments come from a slug lookup or a hashed QR token, never from the body.
 */

export interface RpcFailure {
  status: number;
  message: string;
}

/** Maps a database error to a status and a message that is safe to show. */
export function mapRpcFailure(error: { code?: string; message?: string } | null): RpcFailure {
  const code = error?.code ?? "";
  const message = error?.message ?? "";

  if (code === "P0429") {
    return { status: 429, message: "Too many requests. Please wait a few minutes and try again." };
  }
  if (code === "P0003") {
    return { status: 409, message: "That table is busy. Please ask a team member for help." };
  }
  if (code === "P0001") {
    // Raised by our own SQL with customer-safe wording.
    return { status: 422, message: message || "This order could not be placed." };
  }
  if (code === "42501") {
    return { status: 403, message: "This action is not allowed." };
  }
  return { status: 500, message: "Something went wrong. Please try again." };
}

export function asSettings(value: unknown): OrderingSettings {
  const raw = (value ?? {}) as Partial<OrderingSettings>;
  return {
    online_enabled: raw.online_enabled === true,
    takeaway_enabled: raw.takeaway_enabled !== false,
    delivery_enabled: raw.delivery_enabled === true,
    qr_enabled: raw.qr_enabled === true,
    accepting_orders: raw.accepting_orders !== false,
    auto_accept: raw.auto_accept === true,
    min_order_minor: Number(raw.min_order_minor ?? 0),
    delivery_fee_minor: Number(raw.delivery_fee_minor ?? 0),
    packaging_fee_minor: Number(raw.packaging_fee_minor ?? 0),
    prep_minutes: Number(raw.prep_minutes ?? 20),
  };
}

export async function loadStorefront(
  businessSlug: string,
  outletSlug: string,
): Promise<StorefrontContext | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("public_outlet_context", {
    p_business_slug: businessSlug,
    p_outlet_slug: outletSlug,
  });
  if (error || !data) return null;
  const row = data as Omit<StorefrontContext, "settings"> & { settings: unknown };
  return { ...row, settings: asSettings(row.settings) };
}

export async function loadPublicMenu(businessId: string, outletId: string): Promise<PublicMenu> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("public_menu", {
    p_business_id: businessId,
    p_outlet_id: outletId,
  });
  if (error || !data) return { categories: [], combos: [] };
  return data as PublicMenu;
}

/** Resolves a printed QR token. Unknown, revoked or inactive tokens return null. */
export async function loadQrContext(rawToken: string): Promise<QrContext | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("public_qr_context", {
    p_token_hash: sha256Hex(rawToken),
  });
  if (error || !data) return null;
  const row = data as Omit<QrContext, "settings"> & { settings: unknown };
  return { ...row, settings: asSettings(row.settings) };
}

export interface SubmitInput extends CheckoutInput {
  fingerprint: string;
  businessId: string;
  outletId: string;
  qrCodeId: string | null;
}

/** Converts a validated checkout into the database payload. Only known keys pass. */
export function toDbPayload(input: CheckoutInput): Record<string, unknown> {
  const orderType = input.channel === "qr" ? "dine_in" : input.orderType;
  return {
    client_ref: input.clientRef,
    order_type: orderType,
    customer_name: input.customerName,
    customer_phone: input.customerPhone,
    delivery_address:
      input.channel === "online" && input.orderType === "delivery" ? input.deliveryAddress : null,
    notes: input.notes,
    items: input.items.map((item) => ({
      item_type: item.kind,
      product_id: item.kind === "product" ? item.id : null,
      combo_id: item.kind === "combo" ? item.id : null,
      variant_id: item.variantId ?? null,
      quantity: item.quantity,
      item_notes: item.notes,
      modifiers: item.modifiers.map((m) => ({ modifier_id: m.id, quantity: m.quantity })),
    })),
  };
}

export async function submitPublicOrder(
  input: SubmitInput,
): Promise<{ ok: true; order: PublicOrderStatus } | { ok: false; failure: RpcFailure }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("public_order_create", {
    p_channel: input.channel,
    p_business_id: input.businessId,
    p_outlet_id: input.outletId,
    p_qr_code_id: input.qrCodeId,
    p_payload: toDbPayload(input),
    p_fingerprint: input.fingerprint,
    p_tracking_token_hash: sha256Hex(input.trackingSecret),
  });
  if (error || !data) {
    return { ok: false, failure: mapRpcFailure(error) };
  }
  return { ok: true, order: data as PublicOrderStatus };
}

/** Reads an order only when the caller holds its tracking secret. */
export async function loadPublicOrderStatus(
  orderId: string,
  trackingSecret: string,
): Promise<PublicOrderStatus | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("public_order_status", {
    p_order_id: orderId,
    p_tracking_token_hash: sha256Hex(trackingSecret),
  });
  if (error || !data) return null;
  return data as PublicOrderStatus;
}
