"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSessionUserId,
  permissionErrorMessage,
  requirePermission,
} from "@/lib/rbac/enforce";
import {
  deleteFloorSchema,
  deleteSectionSchema,
  deleteTableSchema,
  mergeTablesSchema,
  reserveTableSchema,
  saveFloorSchema,
  saveSectionSchema,
  saveTableSchema,
  splitOrderSchema,
  tableIdSchema,
  transferTableSchema,
} from "./schemas";

/**
 * Phase 9 — floor & table server actions.
 *
 * Security model (mirrors Phase 8 POS):
 *  - actor = session user, never form input
 *  - every entity is re-resolved server-side; the outlet comes from the row
 *    itself, so a forged outletId cannot smuggle a cross-outlet write
 *  - configuration CRUD needs `outlets.manage`; dine-in operations need
 *    `orders.manage` — both outlet-scoped
 *  - the DB RPCs re-verify membership + outlet grants (require_outlet_access)
 */

export interface FloorActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
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

function collectForm(formData: FormData, arrayKeys: readonly string[] = []): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    raw[key] = arrayKeys.includes(key) ? formData.getAll(key) : formData.get(key);
  }
  return raw;
}

// ── entity → outlet resolution (server-side; never trusts the form) ────────

async function tableOutlet(tableId: string): Promise<{ outletId: string; businessId: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dining_tables")
    .select("outlet_id, business_id")
    .eq("id", tableId)
    .maybeSingle();
  return data ? { outletId: data.outlet_id, businessId: data.business_id } : null;
}

async function floorOutlet(floorId: string): Promise<{ outletId: string; businessId: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("floors")
    .select("outlet_id, business_id")
    .eq("id", floorId)
    .maybeSingle();
  return data ? { outletId: data.outlet_id, businessId: data.business_id } : null;
}

async function sectionOutlet(sectionId: string): Promise<{ outletId: string; businessId: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dining_sections")
    .select("outlet_id, business_id")
    .eq("id", sectionId)
    .maybeSingle();
  return data ? { outletId: data.outlet_id, businessId: data.business_id } : null;
}

async function orderRef(orderId: string): Promise<{ outletId: string; businessId: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("orders")
    .select("outlet_id, business_id")
    .eq("id", orderId)
    .maybeSingle();
  return data ? { outletId: data.outlet_id, businessId: data.business_id } : null;
}

async function outletRow(outletId: string): Promise<{ businessId: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("outlets").select("business_id").eq("id", outletId).maybeSingle();
  return data ? { businessId: data.business_id } : null;
}

/** Zod validation + session + RBAC in one shot; returns what the caller needs. */
async function authorize(
  businessId: string,
  outletId: string,
  permission: "outlets.manage" | "orders.manage",
): Promise<{ userId: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: SIGN_IN_AGAIN };
  try {
    await requirePermission({ businessId, permission, outletId });
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }
  return { userId };
}

// ── configuration: floors ───────────────────────────────────────────────────

export async function saveFloorAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = saveFloorSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const outlet = await outletRow(input.outletId);
  if (!outlet || outlet.businessId !== input.businessId) return { error: "Pick an outlet that belongs to this business." };

  const auth = await authorize(input.businessId, input.outletId, "outlets.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { data: floorId, error } = await admin.rpc("save_floor", {
    p_actor: auth.userId,
    p_floor_id: input.floorId || null,
    p_outlet_id: input.outletId,
    p_name: input.name,
  });
  if (error || !floorId) return { error: error?.message || GENERIC_ERROR };
  return { ok: true };
}

export async function deleteFloorAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = deleteFloorSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const target = await floorOutlet(input.floorId);
  if (!target || target.businessId !== input.businessId) return { error: "Floor not found in this business." };

  const auth = await authorize(input.businessId, target.outletId, "outlets.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { error } = await admin.rpc("delete_floor", {
    p_actor: auth.userId,
    p_floor_id: input.floorId,
  });
  if (error) return { error: error.message || GENERIC_ERROR };
  return { ok: true };
}

// ── configuration: sections ─────────────────────────────────────────────────

export async function saveSectionAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = saveSectionSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const outlet = await outletRow(input.outletId);
  if (!outlet || outlet.businessId !== input.businessId) return { error: "Pick an outlet that belongs to this business." };
  if (input.sectionId) {
    const target = await sectionOutlet(input.sectionId);
    if (!target || target.businessId !== input.businessId || target.outletId !== input.outletId) {
      return { error: "Section not found in this outlet." };
    }
  }

  const auth = await authorize(input.businessId, input.outletId, "outlets.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { data: sectionId, error } = await admin.rpc("save_section", {
    p_actor: auth.userId,
    p_section_id: input.sectionId || null,
    p_outlet_id: input.outletId,
    p_floor_id: input.floorId,
    p_name: input.name,
  });
  if (error || !sectionId) return { error: error?.message || GENERIC_ERROR };
  return { ok: true };
}

export async function deleteSectionAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = deleteSectionSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const target = await sectionOutlet(input.sectionId);
  if (!target || target.businessId !== input.businessId) return { error: "Section not found in this business." };

  const auth = await authorize(input.businessId, target.outletId, "outlets.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { error } = await admin.rpc("delete_section", {
    p_actor: auth.userId,
    p_section_id: input.sectionId,
  });
  if (error) return { error: error.message || GENERIC_ERROR };
  return { ok: true };
}

// ── configuration: tables ───────────────────────────────────────────────────

export async function saveTableAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = saveTableSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const outlet = await outletRow(input.outletId);
  if (!outlet || outlet.businessId !== input.businessId) return { error: "Pick an outlet that belongs to this business." };
  const section = await sectionOutlet(input.sectionId);
  if (!section || section.businessId !== input.businessId || section.outletId !== input.outletId) {
    return { error: "Pick a section that belongs to this outlet." };
  }
  if (input.tableId) {
    const existing = await tableOutlet(input.tableId);
    if (!existing || existing.businessId !== input.businessId || existing.outletId !== input.outletId) {
      return { error: "Table not found in this outlet." };
    }
  }

  const auth = await authorize(input.businessId, input.outletId, "outlets.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { data: tableId, error } = await admin.rpc("save_table", {
    p_actor: auth.userId,
    p_table_id: input.tableId || null,
    p_outlet_id: input.outletId,
    p_section_id: input.sectionId,
    p_label: input.label,
    p_capacity: input.capacity,
  });
  if (error || !tableId) return { error: error?.message || GENERIC_ERROR };
  return { ok: true };
}

export async function deleteTableAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = deleteTableSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const target = await tableOutlet(input.tableId);
  if (!target || target.businessId !== input.businessId) return { error: "Table not found in this business." };

  const auth = await authorize(input.businessId, target.outletId, "outlets.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { error } = await admin.rpc("delete_table", {
    p_actor: auth.userId,
    p_table_id: input.tableId,
  });
  if (error) return { error: error.message || GENERIC_ERROR };
  return { ok: true };
}

// ── dine-in operations ──────────────────────────────────────────────────────

export async function reserveTableAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = reserveTableSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const target = await tableOutlet(input.tableId);
  if (!target || target.businessId !== input.businessId) return { error: "Table not found in this business." };

  const auth = await authorize(input.businessId, target.outletId, "orders.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { error } = await admin.rpc("reserve_table", {
    p_actor: auth.userId,
    p_table_id: input.tableId,
    p_note: input.note ?? null,
  });
  if (error) return { error: error.message || GENERIC_ERROR };
  return { ok: true };
}

export async function releaseTableAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = tableIdSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const target = await tableOutlet(input.tableId);
  if (!target || target.businessId !== input.businessId) return { error: "Table not found in this business." };

  const auth = await authorize(input.businessId, target.outletId, "orders.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { error } = await admin.rpc("release_table", {
    p_actor: auth.userId,
    p_table_id: input.tableId,
  });
  if (error) return { error: error.message || GENERIC_ERROR };
  return { ok: true };
}

export async function transferTableAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = transferTableSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const order = await orderRef(input.orderId);
  if (!order || order.businessId !== input.businessId) return { error: "Order not found in this business." };

  const auth = await authorize(input.businessId, order.outletId, "orders.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { error } = await admin.rpc("transfer_table", {
    p_actor: auth.userId,
    p_order_id: input.orderId,
    p_to_table_id: input.toTableId,
  });
  if (error) return { error: error.message || GENERIC_ERROR };
  return { ok: true };
}

export async function mergeTablesAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = mergeTablesSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const keep = await orderRef(input.keepOrderId);
  if (!keep || keep.businessId !== input.businessId) return { error: "Order not found in this business." };

  const auth = await authorize(input.businessId, keep.outletId, "orders.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { error } = await admin.rpc("merge_tables", {
    p_actor: auth.userId,
    p_keep_order_id: input.keepOrderId,
    p_merge_order_id: input.mergeOrderId,
  });
  if (error) return { error: error.message || GENERIC_ERROR };
  return { ok: true };
}

export async function splitOrderAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = splitOrderSchema.safeParse(collectForm(formData, ["itemIds"]));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const order = await orderRef(input.orderId);
  if (!order || order.businessId !== input.businessId) return { error: "Order not found in this business." };

  const auth = await authorize(input.businessId, order.outletId, "orders.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { data: newOrderId, error } = await admin.rpc("split_order", {
    p_actor: auth.userId,
    p_order_id: input.orderId,
    p_item_ids: input.itemIds,
    p_to_table_id: input.toTableId,
  });
  if (error || !newOrderId) return { error: error?.message || GENERIC_ERROR };
  return { ok: true };
}

export async function completeTableAction(
  _previous: FloorActionState | undefined,
  formData: FormData,
): Promise<FloorActionState> {
  const parsed = tableIdSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), error: "Please fix the highlighted fields." };
  const input = parsed.data;

  const target = await tableOutlet(input.tableId);
  if (!target || target.businessId !== input.businessId) return { error: "Table not found in this business." };

  const auth = await authorize(input.businessId, target.outletId, "orders.manage");
  if ("error" in auth) return auth;

  const admin = createAdminClient();
  const { error } = await admin.rpc("complete_table", {
    p_actor: auth.userId,
    p_table_id: input.tableId,
  });
  if (error) return { error: error.message || GENERIC_ERROR };
  return { ok: true };
}
