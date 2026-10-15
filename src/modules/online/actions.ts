"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUserId, permissionErrorMessage, requirePermission } from "@/lib/rbac/enforce";
import { mapRpcFailure } from "./public-service";
import {
  intakeActionSchema,
  qrIssueSchema,
  qrRevokeSchema,
  rejectActionSchema,
  settingsActionSchema,
} from "./schemas";
import { randomToken, sha256Hex } from "./security";
import type { OrderingSettings } from "./types";
import { z } from "zod";

/**
 * Phase 17 — staff actions for online intake, ordering settings and QR codes.
 *
 * Security model:
 *  • The actor is the session user. Form input never supplies it.
 *  • Each action checks the permission in TypeScript and again in the database,
 *    which also checks outlet access. The database is the authority.
 *  • Accepting and rejecting need orders.manage. Settings and QR codes need settings.manage.
 *  • A QR token is shown once, at issue. Only its hash is stored.
 */

export type ActionResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: string };

const SIGN_IN_AGAIN = "Please sign in again.";
const GENERIC = "Something went wrong. Please try again.";

function zodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the highlighted fields.";
}

/** Database messages with our own wording are shown. Anything else is generic. */
function userMessage(error: { code?: string; message?: string } | null): string {
  const code = error?.code ?? "";
  if (code === "P0001" || code === "P0003" || code === "42501") {
    return error?.message || GENERIC;
  }
  return mapRpcFailure(error).message || GENERIC;
}

async function actorOrError(): Promise<{ userId: string } | { error: string }> {
  const userId = await getSessionUserId();
  return userId ? { userId } : { error: SIGN_IN_AGAIN };
}

function revalidateStaffPages() {
  revalidatePath("/orders/online");
  revalidatePath("/orders");
  revalidatePath("/settings/ordering");
}

export async function acceptOnlineOrderAction(input: unknown): Promise<ActionResult> {
  const parsed = intakeActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const actor = await actorOrError();
  if ("error" in actor) return { ok: false, error: actor.error };

  try {
    await requirePermission({
      businessId: parsed.data.businessId,
      permission: "orders.manage",
      outletId: parsed.data.outletId,
    });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("online_order_accept", {
    p_actor: actor.userId,
    p_order_id: parsed.data.orderId,
  });
  if (error) return { ok: false, error: userMessage(error) };

  revalidateStaffPages();
  return { ok: true };
}

export async function rejectOnlineOrderAction(input: unknown): Promise<ActionResult> {
  const parsed = rejectActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const actor = await actorOrError();
  if ("error" in actor) return { ok: false, error: actor.error };

  try {
    await requirePermission({
      businessId: parsed.data.businessId,
      permission: "orders.manage",
      outletId: parsed.data.outletId,
    });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("online_order_reject", {
    p_actor: actor.userId,
    p_order_id: parsed.data.orderId,
    p_reason: parsed.data.reason,
  });
  if (error) return { ok: false, error: userMessage(error) };

  revalidateStaffPages();
  return { ok: true };
}

export async function saveOrderingSettingsAction(
  input: unknown,
): Promise<ActionResult<{ settings: OrderingSettings }>> {
  const parsed = settingsActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const actor = await actorOrError();
  if ("error" in actor) return { ok: false, error: actor.error };

  try {
    await requirePermission({
      businessId: parsed.data.businessId,
      permission: "settings.manage",
      outletId: parsed.data.outletId,
    });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }

  const v = parsed.data;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("ordering_settings_save", {
    p_actor: actor.userId,
    p_outlet_id: v.outletId,
    p_settings: {
      online_enabled: v.onlineEnabled,
      takeaway_enabled: v.takeawayEnabled,
      delivery_enabled: v.deliveryEnabled,
      qr_enabled: v.qrEnabled,
      accepting_orders: v.acceptingOrders,
      auto_accept: v.autoAccept,
      min_order_minor: v.minOrderMinor,
      delivery_fee_minor: v.deliveryFeeMinor,
      packaging_fee_minor: v.packagingFeeMinor,
      prep_minutes: v.prepMinutes,
    },
  });
  if (error) return { ok: false, error: userMessage(error) };

  revalidateStaffPages();
  return { ok: true, settings: data as OrderingSettings };
}

export async function issueQrCodeAction(
  input: unknown,
): Promise<ActionResult<{ url: string; svg: string; label: string; tableLabel: string }>> {
  const parsed = qrIssueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const actor = await actorOrError();
  if ("error" in actor) return { ok: false, error: actor.error };

  try {
    await requirePermission({
      businessId: parsed.data.businessId,
      permission: "settings.manage",
      outletId: parsed.data.outletId,
    });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }

  // 24 random bytes → 32 url-safe characters. The raw token is returned once and never stored.
  const token = randomToken(24);
  const admin = createAdminClient();
  const { data: qrId, error } = await admin.rpc("qr_code_issue", {
    p_actor: actor.userId,
    p_outlet_id: parsed.data.outletId,
    p_table_id: parsed.data.tableId,
    p_label: parsed.data.label,
    p_token_hash: sha256Hex(token),
    p_token_prefix: token.slice(0, 6),
  });
  if (error || !qrId) return { ok: false, error: userMessage(error) };

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || `${proto}://${host}`;
  const url = `${base}/q/${token}`;
  const svg = await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280,
  });

  const { data: tableRows } = await admin
    .from("dining_tables")
    .select("label")
    .eq("id", parsed.data.tableId)
    .maybeSingle();

  revalidateStaffPages();
  return {
    ok: true,
    url,
    svg,
    label: parsed.data.label,
    tableLabel: tableRows?.label ?? "Table",
  };
}

export async function revokeQrCodeAction(input: unknown): Promise<ActionResult> {
  const parsed = qrRevokeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const actor = await actorOrError();
  if ("error" in actor) return { ok: false, error: actor.error };

  try {
    await requirePermission({
      businessId: parsed.data.businessId,
      permission: "settings.manage",
      outletId: parsed.data.outletId,
    });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("qr_code_revoke", {
    p_actor: actor.userId,
    p_qr_id: parsed.data.qrId,
  });
  if (error) return { ok: false, error: userMessage(error) };

  revalidateStaffPages();
  return { ok: true };
}
