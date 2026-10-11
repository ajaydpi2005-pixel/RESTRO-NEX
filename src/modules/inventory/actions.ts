"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSessionUserId,
  permissionErrorMessage,
  requirePermission,
} from "@/lib/rbac/enforce";
import { rupeesToMinorUnitCost } from "@/modules/inventory/math";
import {
  countSchema,
  ingredientSchema,
  parseJsonLines,
  receiveSchema,
  recipeSchema,
  transferSchema,
  wasteSchema,
} from "@/modules/inventory/schemas";

/**
 * Phase 13 — inventory server actions.
 *
 * Every action re-checks the session and the permission (inventory.manage
 * per outlet for stock, menu.manage for recipes) before calling a SQL RPC.
 * The RPCs re-check the same rules, recompute base quantities, and refuse
 * shortfalls where the spec requires it. Error text from the database is
 * shown only for the business-rule codes we raise (P0001, 42501).
 */

export interface InventoryActionState {
  ok?: boolean;
  error?: string;
  id?: string;
}

const GENERIC_ERROR = "That did not go through. Refresh the page and try again.";
const SIGN_IN_AGAIN = "Sign in again to keep working.";

function values(formData: FormData): Record<string, FormDataEntryValue | null> {
  return Object.fromEntries(formData.entries());
}

function bool(value: FormDataEntryValue | null | undefined): boolean {
  return value === "on" || value === "true";
}

function userMessage(error: { code?: string; message?: string }): string {
  if (error.code === "P0001" || error.code === "42501") return error.message ?? GENERIC_ERROR;
  return GENERIC_ERROR;
}

async function callRpc(
  name: string,
  args: Record<string, unknown>,
  actorId: string,
): Promise<InventoryActionState> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, { p_actor: actorId, ...args });
  if (error) return { ok: false, error: userMessage(error) };
  return { ok: true, id: typeof data === "string" ? data : undefined };
}

async function authorise(
  businessId: string,
  permission: "inventory.manage" | "menu.manage",
  outletIds: string[] = [],
): Promise<{ actorId: string } | { error: string }> {
  const actorId = await getSessionUserId();
  if (!actorId) return { error: SIGN_IN_AGAIN };
  try {
    await requirePermission({ businessId, permission });
    for (const outletId of outletIds) {
      await requirePermission({ businessId, permission, outletId });
    }
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }
  return { actorId };
}

export async function saveIngredientAction(
  _prev: InventoryActionState | undefined,
  formData: FormData,
): Promise<InventoryActionState> {
  const v = values(formData);
  const parsed = ingredientSchema.safeParse({
    businessId: v.businessId,
    id: v.id,
    name: v.name,
    unit: v.unit,
    costPerUnit: v.costPerUnit,
    minimumStock: v.minimumStock,
    maximumStock: v.maximumStock,
    active: bool(v.active),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
  const input = parsed.data;

  const auth = await authorise(input.businessId, "inventory.manage");
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "ingredient_save",
    {
      p_business_id: input.businessId,
      p_id: input.id ?? null,
      p_name: input.name,
      p_unit: input.unit,
      p_cost_per_unit: rupeesToMinorUnitCost(input.costPerUnit),
      p_minimum_stock: input.minimumStock ?? null,
      p_maximum_stock: input.maximumStock ?? null,
      p_active: input.active,
    },
    auth.actorId,
  );
}

export async function receiveStockAction(
  _prev: InventoryActionState | undefined,
  formData: FormData,
): Promise<InventoryActionState> {
  const v = values(formData);
  const parsed = receiveSchema.safeParse({
    outletId: v.outletId,
    ingredientId: v.ingredientId,
    qty: v.qty,
    unit: v.unit,
    unitCost: v.unitCost,
    batchCode: v.batchCode,
    expiresOn: v.expiresOn,
    clientRef: v.clientRef,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
  const input = parsed.data;
  const businessId = typeof v.businessId === "string" ? v.businessId : "";

  const auth = await authorise(businessId, "inventory.manage", [input.outletId]);
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "inventory_receive",
    {
      p_outlet_id: input.outletId,
      p_ingredient_id: input.ingredientId,
      p_qty: input.qty,
      p_unit: input.unit,
      p_unit_cost: rupeesToMinorUnitCost(input.unitCost),
      p_batch_code: input.batchCode ?? null,
      p_expires_on: input.expiresOn ?? null,
      p_client_ref: `recv:${input.clientRef}`,
    },
    auth.actorId,
  );
}

export async function wasteStockAction(
  _prev: InventoryActionState | undefined,
  formData: FormData,
): Promise<InventoryActionState> {
  const v = values(formData);
  const parsed = wasteSchema.safeParse({
    outletId: v.outletId,
    ingredientId: v.ingredientId,
    qty: v.qty,
    unit: v.unit,
    reason: v.reason,
    clientRef: v.clientRef,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
  const input = parsed.data;
  const businessId = typeof v.businessId === "string" ? v.businessId : "";

  const auth = await authorise(businessId, "inventory.manage", [input.outletId]);
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "inventory_waste",
    {
      p_outlet_id: input.outletId,
      p_ingredient_id: input.ingredientId,
      p_qty: input.qty,
      p_unit: input.unit,
      p_reason: input.reason,
      p_client_ref: `waste:${input.clientRef}`,
    },
    auth.actorId,
  );
}

export async function countStockAction(
  _prev: InventoryActionState | undefined,
  formData: FormData,
): Promise<InventoryActionState> {
  const v = values(formData);
  const parsed = countSchema.safeParse({
    outletId: v.outletId,
    ingredientId: v.ingredientId,
    counted: v.counted,
    unit: v.unit,
    reason: v.reason,
    clientRef: v.clientRef,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
  const input = parsed.data;
  const businessId = typeof v.businessId === "string" ? v.businessId : "";

  const auth = await authorise(businessId, "inventory.manage", [input.outletId]);
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "inventory_adjust",
    {
      p_outlet_id: input.outletId,
      p_ingredient_id: input.ingredientId,
      p_counted: input.counted,
      p_unit: input.unit,
      p_reason: input.reason,
      p_client_ref: `count:${input.clientRef}`,
    },
    auth.actorId,
  );
}

export async function transferStockAction(
  _prev: InventoryActionState | undefined,
  formData: FormData,
): Promise<InventoryActionState> {
  const v = values(formData);
  const lines = parseJsonLines(v.lines);
  const parsed = transferSchema.safeParse({
    fromOutletId: v.fromOutletId,
    toOutletId: v.toOutletId,
    note: v.note,
    lines,
    clientRef: v.clientRef,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
  const input = parsed.data;
  const businessId = typeof v.businessId === "string" ? v.businessId : "";

  const auth = await authorise(businessId, "inventory.manage", [input.fromOutletId, input.toOutletId]);
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "inventory_transfer",
    {
      p_from_outlet_id: input.fromOutletId,
      p_to_outlet_id: input.toOutletId,
      p_lines: input.lines.map((line) => ({
        ingredient_id: line.ingredientId,
        unit: line.unit,
        qty: line.qty,
      })),
      p_note: input.note ?? null,
      p_client_ref: `transfer:${input.clientRef}`,
    },
    auth.actorId,
  );
}

export async function saveRecipeAction(
  _prev: InventoryActionState | undefined,
  formData: FormData,
): Promise<InventoryActionState> {
  const v = values(formData);
  const parsed = recipeSchema.safeParse({
    businessId: v.businessId,
    menuItemId: v.menuItemId,
    lines: parseJsonLines(v.lines) ?? "invalid",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the recipe lines." };
  const input = parsed.data;

  const auth = await authorise(input.businessId, "menu.manage");
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "recipe_save",
    {
      p_menu_item_id: input.menuItemId,
      p_lines: input.lines.map((line) => ({
        ingredient_id: line.ingredientId,
        unit: line.unit,
        qty: line.qty,
      })),
    },
    auth.actorId,
  );
}
