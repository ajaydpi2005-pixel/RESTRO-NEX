"use server";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSessionUserId,
  permissionErrorMessage,
  requirePermission,
} from "@/lib/rbac/enforce";
import {
  categorySchema,
  comboItemRowsSchema,
  comboSchema,
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  modifierGroupSchema,
  modifierRowsSchema,
  outletOverrideRowsSchema,
  productBaseSchema,
  renameCategorySchema,
  variantRowsSchema,
} from "@/modules/menu/schemas";

/**
 * Phase 7 — Universal menu server actions.
 *
 * Security model:
 *  - actor = session user, never form input
 *  - hidden businessId is a SELECTOR; membership + RBAC are re-verified
 *    server-side on every operation (menu.view reads, menu.manage writes)
 *  - every entity's business ownership is checked before writes
 *  - tables have zero client-write policies; writes use the service role
 */

export interface MenuActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  productId?: string;
  comboId?: string;
  groupId?: string;
  categoryId?: string;
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

async function authorizeMenuWrite(businessId: string): Promise<{ userId: string } | { error: string }> {
  if (!businessId) return { error: GENERIC_ERROR };
  const userId = await getSessionUserId();
  if (!userId) return { error: SIGN_IN_AGAIN };
  try {
    await requirePermission({ businessId, permission: "menu.manage" });
    return { userId };
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }
}

async function inBusiness(table: string, id: string, businessId: string): Promise<boolean> {
  if (!id) return false;
  const admin = createAdminClient();
  const { data } = await admin.from(table).select("id, business_id").eq("id", id).maybeSingle();
  return data?.business_id === businessId;
}

function skuConflict(error: unknown): MenuActionState {
  const pgCode = (error as { code?: string } | null)?.code;
  if (pgCode === "23505") {
    return { fieldErrors: { sku: ["This SKU is already used in your menu."] } };
  }
  return { error: GENERIC_ERROR };
}

// ── categories ──────────────────────────────────────────────────────────────

export async function createCategoryAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const parsed = categorySchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };
  const input = parsed.data;

  if (input.parentId && !(await inBusiness("menu_categories", input.parentId, businessId))) {
    return { error: "Parent category not found in this business." };
  }
  if (input.parentId) {
    const admin = createAdminClient();
    const { data: parent } = await admin
      .from("menu_categories")
      .select("parent_id")
      .eq("id", input.parentId)
      .maybeSingle();
    if (parent?.parent_id) {
      return { error: "Subcategories can only sit under top-level categories." };
    }
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("menu_categories")
    .insert({ business_id: businessId, name: input.name, parent_id: input.parentId })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      return { fieldErrors: { name: ["A category with this name already exists."] } };
    }
    return { error: GENERIC_ERROR };
  }
  return { ok: true, categoryId: data.id };
}

export async function renameCategoryAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const parsed = renameCategorySchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };
  if (!(await inBusiness("menu_categories", parsed.data.categoryId, businessId))) {
    return { error: "Category not found in this business." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("menu_categories")
    .update({ name: parsed.data.name })
    .eq("id", parsed.data.categoryId)
    .eq("business_id", businessId);
  if (error) {
    if (error.code === "23505") {
      return { fieldErrors: { name: ["A category with this name already exists."] } };
    }
    return { error: GENERIC_ERROR };
  }
  return { ok: true };
}

export async function deleteCategoryAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const categoryId = String(formData.get("categoryId") ?? "");
  if (!(await inBusiness("menu_categories", categoryId, businessId))) {
    return { error: "Category not found in this business." };
  }

  const admin = createAdminClient();
  const { count: children } = await admin
    .from("menu_categories")
    .select("id", { count: "exact", head: true })
    .eq("parent_id", categoryId);
  if ((children ?? 0) > 0) {
    return { error: "Move or delete its subcategories first." };
  }
  const { count: products } = await admin
    .from("menu_items")
    .select("id", { count: "exact", head: true })
    .eq("category_id", categoryId);
  if ((products ?? 0) > 0) {
    return { error: "Move or delete its products first." };
  }

  const { error } = await admin
    .from("menu_categories")
    .delete()
    .eq("id", categoryId)
    .eq("business_id", businessId);
  if (error) return { error: GENERIC_ERROR };
  return { ok: true };
}

// ── products ────────────────────────────────────────────────────────────────

export async function createProductAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const parsed = productBaseSchema.safeParse(collectForm(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };
  const input = parsed.data;

  if (!(await inBusiness("menu_categories", input.categoryId, businessId))) {
    return { fieldErrors: { categoryId: ["Pick a category from this business."] } };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("menu_items")
    .insert({
      business_id: businessId,
      category_id: input.categoryId,
      name: input.name,
      description: input.description,
      sku: input.sku,
      price_minor: input.price,
      tax_rate_pct: input.taxRate,
      is_vegetarian: input.foodType === "veg",
      is_available: input.isAvailable,
    })
    .select("id")
    .single();
  if (error) return skuConflict(error);
  return { ok: true, productId: data.id };
}

export async function updateProductAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const raw = collectForm(formData, ["variantId", "variantName", "variantPrice", "variantSku"]);
  const productId = String(raw["productId"] ?? "");
  const parsed = productBaseSchema.safeParse(raw);
  const variantsParsed = variantRowsSchema.safeParse(raw);
  if (!parsed.success || !variantsParsed.success) {
    return {
      fieldErrors: {
        ...(parsed.success ? {} : zodFieldErrors(parsed.error)),
        ...(variantsParsed.success ? {} : zodFieldErrors(variantsParsed.error)),
      },
    };
  }
  if (!(await inBusiness("menu_items", productId, businessId))) {
    return { error: "Product not found in this business." };
  }
  const input = parsed.data;
  if (!(await inBusiness("menu_categories", input.categoryId, businessId))) {
    return { fieldErrors: { categoryId: ["Pick a category from this business."] } };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("menu_items")
    .update({
      category_id: input.categoryId,
      name: input.name,
      description: input.description,
      sku: input.sku,
      price_minor: input.price,
      tax_rate_pct: input.taxRate,
      is_vegetarian: input.foodType === "veg",
      is_available: input.isAvailable,
    })
    .eq("id", productId)
    .eq("business_id", businessId);
  if (error) return skuConflict(error);

  // ── variant diff: update survivors, insert new, delete the omitted ──────
  const rows = variantsParsed.data.variants;
  const { data: existing } = await admin
    .from("product_variants")
    .select("id")
    .eq("product_id", productId);
  const keptIds = new Set(rows.map((row) => row.id).filter((id): id is string => id !== null));
  const removed = (existing ?? []).filter((variant) => !keptIds.has(variant.id)).map((variant) => variant.id);
  if (removed.length > 0) {
    await admin.from("product_variants").delete().in("id", removed).eq("product_id", productId);
  }

  for (const [index, row] of rows.entries()) {
    if (row.id) {
      const { error: rowError } = await admin
        .from("product_variants")
        .update({ name: row.name, price_minor: row.priceMinor, sku: row.sku, sort_order: index })
        .eq("id", row.id)
        .eq("product_id", productId);
      if (rowError) return skuConflict(rowError);
    } else {
      const { error: rowError } = await admin.from("product_variants").insert({
        business_id: businessId,
        product_id: productId,
        name: row.name,
        price_minor: row.priceMinor,
        sku: row.sku,
        sort_order: index,
      });
      if (rowError) return skuConflict(rowError);
    }
  }

  return { ok: true, productId };
}

export async function deleteProductAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const productId = String(formData.get("productId") ?? "");
  if (!(await inBusiness("menu_items", productId, businessId))) {
    return { error: "Product not found in this business." };
  }
  const admin = createAdminClient();
  const { error } = await admin.from("menu_items").delete().eq("id", productId).eq("business_id", businessId);
  if (error) return { error: GENERIC_ERROR };
  return { ok: true };
}

export async function bulkProductsAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const mode = String(formData.get("bulkMode") ?? "");
  const ids = formData
    .getAll("productId")
    .map((value) => String(value))
    .filter((value) => /^[0-9a-f-]{36}$/.test(value));
  if (ids.length === 0) return { error: "Select at least one product." };
  if (ids.length > 200) return { error: "Bulk operations are limited to 200 products." };
  if (!["available", "unavailable", "delete"].includes(mode)) return { error: GENERIC_ERROR };

  const admin = createAdminClient();
  if (mode === "delete") {
    const { error } = await admin.from("menu_items").delete().eq("business_id", businessId).in("id", ids);
    if (error) return { error: GENERIC_ERROR };
  } else {
    const { error } = await admin
      .from("menu_items")
      .update({ is_available: mode === "available" })
      .eq("business_id", businessId)
      .in("id", ids);
    if (error) return { error: GENERIC_ERROR };
  }
  return { ok: true };
}

// ── outlet overrides ────────────────────────────────────────────────────────

export async function saveOutletOverridesAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const raw = collectForm(formData, ["overrideOutletId", "overridePrice", "overrideAvailable"]);
  const productId = String(raw["productId"] ?? "");
  const parsed = outletOverrideRowsSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };
  if (!(await inBusiness("menu_items", productId, businessId))) {
    return { error: "Product not found in this business." };
  }

  const admin = createAdminClient();
  const { data: outlets } = await admin
    .from("outlets")
    .select("id")
    .eq("business_id", businessId);
  const valid = new Set((outlets ?? []).map((outlet) => outlet.id));
  const rows = parsed.data.overrides.filter((row) => valid.has(row.outletId));

  for (const row of rows) {
    const meaningless = row.priceMinor === null && row.isAvailable === true;
    if (meaningless) {
      await admin
        .from("outlet_product_overrides")
        .delete()
        .eq("outlet_id", row.outletId)
        .eq("product_id", productId);
    } else {
      const { error } = await admin.from("outlet_product_overrides").upsert(
        {
          outlet_id: row.outletId,
          product_id: productId,
          price_minor: row.priceMinor,
          is_available: row.isAvailable,
        },
        { onConflict: "outlet_id,product_id" },
      );
      if (error) return { error: GENERIC_ERROR };
    }
  }
  return { ok: true, productId };
}

// ── modifier groups ─────────────────────────────────────────────────────────

export async function createModifierGroupAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const raw = collectForm(formData, ["modifierId", "modifierName", "modifierPrice"]);
  const groupParsed = modifierGroupSchema.safeParse(raw);
  const modifiersParsed = modifierRowsSchema.safeParse(raw);
  if (!groupParsed.success || !modifiersParsed.success) {
    return {
      fieldErrors: {
        ...(groupParsed.success ? {} : zodFieldErrors(groupParsed.error)),
        ...(modifiersParsed.success ? {} : zodFieldErrors(modifiersParsed.error)),
      },
    };
  }

  const admin = createAdminClient();
  const { data: group, error } = await admin
    .from("modifier_groups")
    .insert({
      business_id: businessId,
      name: groupParsed.data.name,
      min_selected: groupParsed.data.minSelected,
      max_selected: groupParsed.data.maxSelected,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { fieldErrors: { name: ["A group with this name already exists."] } };
    return { error: GENERIC_ERROR };
  }

  for (const [index, modifier] of modifiersParsed.data.modifiers.entries()) {
    const { error: rowError } = await admin.from("modifiers").insert({
      business_id: businessId,
      modifier_group_id: group.id,
      name: modifier.name,
      price_minor: modifier.priceMinor,
      sort_order: index,
    });
    if (rowError) {
      await admin.from("modifier_groups").delete().eq("id", group.id);
      if (rowError.code === "23505") return { fieldErrors: { modifierName: ["Duplicate option names are not allowed."] } };
      return { error: GENERIC_ERROR };
    }
  }
  return { ok: true, groupId: group.id };
}

export async function updateModifierGroupAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const raw = collectForm(formData, ["modifierId", "modifierName", "modifierPrice"]);
  const groupId = String(raw["groupId"] ?? "");
  const groupParsed = modifierGroupSchema.safeParse(raw);
  const modifiersParsed = modifierRowsSchema.safeParse(raw);
  if (!groupParsed.success || !modifiersParsed.success) {
    return {
      fieldErrors: {
        ...(groupParsed.success ? {} : zodFieldErrors(groupParsed.error)),
        ...(modifiersParsed.success ? {} : zodFieldErrors(modifiersParsed.error)),
      },
    };
  }
  if (!(await inBusiness("modifier_groups", groupId, businessId))) {
    return { error: "Modifier group not found in this business." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("modifier_groups")
    .update({
      name: groupParsed.data.name,
      min_selected: groupParsed.data.minSelected,
      max_selected: groupParsed.data.maxSelected,
    })
    .eq("id", groupId)
    .eq("business_id", businessId);
  if (error) {
    if (error.code === "23505") return { fieldErrors: { name: ["A group with this name already exists."] } };
    return { error: GENERIC_ERROR };
  }

  // modifier diff
  const rows = modifiersParsed.data.modifiers;
  const { data: existing } = await admin.from("modifiers").select("id").eq("modifier_group_id", groupId);
  const kept = new Set(rows.map((row) => row.id).filter((id): id is string => id !== null));
  const removed = (existing ?? []).filter((modifier) => !kept.has(modifier.id)).map((modifier) => modifier.id);
  if (removed.length > 0) {
    await admin.from("modifiers").delete().in("id", removed).eq("modifier_group_id", groupId);
  }
  for (const [index, row] of rows.entries()) {
    if (row.id) {
      const { error: rowError } = await admin
        .from("modifiers")
        .update({ name: row.name, price_minor: row.priceMinor, sort_order: index })
        .eq("id", row.id)
        .eq("modifier_group_id", groupId);
      if (rowError) return { error: GENERIC_ERROR };
    } else {
      const { error: rowError } = await admin.from("modifiers").insert({
        business_id: businessId,
        modifier_group_id: groupId,
        name: row.name,
        price_minor: row.priceMinor,
        sort_order: index,
      });
      if (rowError) return { error: GENERIC_ERROR };
    }
  }
  return { ok: true, groupId };
}

export async function deleteModifierGroupAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const groupId = String(formData.get("groupId") ?? "");
  if (!(await inBusiness("modifier_groups", groupId, businessId))) {
    return { error: "Modifier group not found in this business." };
  }
  const admin = createAdminClient();
  const { error } = await admin.from("modifier_groups").delete().eq("id", groupId).eq("business_id", businessId);
  if (error) return { error: GENERIC_ERROR };
  return { ok: true };
}

export async function attachModifierGroupAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const productId = String(formData.get("productId") ?? "");
  const groupId = String(formData.get("groupId") ?? "");
  if (!(await inBusiness("menu_items", productId, businessId))) return { error: "Product not found." };
  if (!(await inBusiness("modifier_groups", groupId, businessId))) return { error: "Modifier group not found." };

  const admin = createAdminClient();
  const { error } = await admin
    .from("product_modifier_groups")
    .insert({ product_id: productId, modifier_group_id: groupId });
  if (error) {
    if (error.code === "23505") return { error: "This group is already attached to the product." };
    return { error: GENERIC_ERROR };
  }
  return { ok: true };
}

export async function detachModifierGroupAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const productId = String(formData.get("productId") ?? "");
  const groupId = String(formData.get("groupId") ?? "");
  if (!(await inBusiness("menu_items", productId, businessId))) return { error: "Product not found." };
  if (!(await inBusiness("modifier_groups", groupId, businessId))) return { error: "Modifier group not found." };

  const admin = createAdminClient();
  const { error } = await admin
    .from("product_modifier_groups")
    .delete()
    .eq("product_id", productId)
    .eq("modifier_group_id", groupId);
  if (error) return { error: GENERIC_ERROR };
  return { ok: true };
}

// ── combos ──────────────────────────────────────────────────────────────────

async function persistComboItems(
  comboId: string,
  items: { productId: string; variantId: string | null; quantity: number }[],
): Promise<MenuActionState | null> {
  const admin = createAdminClient();
  for (const [index, item] of items.entries()) {
    const { data: product } = await admin
      .from("menu_items")
      .select("id, business_id")
      .eq("id", item.productId)
      .maybeSingle();
    const { data: combo } = await admin.from("combos").select("business_id").eq("id", comboId).maybeSingle();
    if (!product || !combo || product.business_id !== combo.business_id) {
      return { error: "Combos can only include products from this business." };
    }
    if (item.variantId) {
      const { data: variant } = await admin
        .from("product_variants")
        .select("id, product_id")
        .eq("id", item.variantId)
        .maybeSingle();
      if (!variant || variant.product_id !== item.productId) {
        return { error: "A combo item's variant must belong to its product." };
      }
    }
    const { error } = await admin.from("combo_items").insert({
      combo_id: comboId,
      product_id: item.productId,
      variant_id: item.variantId,
      quantity: item.quantity,
      sort_order: index,
    });
    if (error) return { error: GENERIC_ERROR };
  }
  return null;
}

export async function createComboAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const raw = collectForm(formData, ["comboProductId", "comboVariantId", "comboQuantity"]);
  const comboParsed = comboSchema.safeParse(raw);
  const itemsParsed = comboItemRowsSchema.safeParse(raw);
  if (!comboParsed.success || !itemsParsed.success) {
    return {
      fieldErrors: {
        ...(comboParsed.success ? {} : zodFieldErrors(comboParsed.error)),
        ...(itemsParsed.success ? {} : zodFieldErrors(itemsParsed.error)),
      },
    };
  }
  const input = comboParsed.data;

  const admin = createAdminClient();
  const { data: combo, error } = await admin
    .from("combos")
    .insert({
      business_id: businessId,
      name: input.name,
      description: input.description,
      sku: input.sku,
      price_minor: input.price,
      tax_rate_pct: input.taxRate,
      is_vegetarian: input.foodType === "veg",
      is_available: input.isAvailable,
    })
    .select("id")
    .single();
  if (error) return skuConflict(error);

  const itemError = await persistComboItems(combo.id, itemsParsed.data.items);
  if (itemError) {
    await admin.from("combos").delete().eq("id", combo.id);
    return itemError;
  }
  return { ok: true, comboId: combo.id };
}

export async function updateComboAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const raw = collectForm(formData, ["comboProductId", "comboVariantId", "comboQuantity"]);
  const comboId = String(raw["comboId"] ?? "");
  const comboParsed = comboSchema.safeParse(raw);
  const itemsParsed = comboItemRowsSchema.safeParse(raw);
  if (!comboParsed.success || !itemsParsed.success) {
    return {
      fieldErrors: {
        ...(comboParsed.success ? {} : zodFieldErrors(comboParsed.error)),
        ...(itemsParsed.success ? {} : zodFieldErrors(itemsParsed.error)),
      },
    };
  }
  if (!(await inBusiness("combos", comboId, businessId))) {
    return { error: "Combo not found in this business." };
  }
  const input = comboParsed.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from("combos")
    .update({
      name: input.name,
      description: input.description,
      sku: input.sku,
      price_minor: input.price,
      tax_rate_pct: input.taxRate,
      is_vegetarian: input.foodType === "veg",
      is_available: input.isAvailable,
    })
    .eq("id", comboId)
    .eq("business_id", businessId);
  if (error) return skuConflict(error);

  await admin.from("combo_items").delete().eq("combo_id", comboId);
  const itemError = await persistComboItems(comboId, itemsParsed.data.items);
  if (itemError) return itemError;
  return { ok: true, comboId };
}

export async function deleteComboAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const comboId = String(formData.get("comboId") ?? "");
  if (!(await inBusiness("combos", comboId, businessId))) {
    return { error: "Combo not found in this business." };
  }
  const admin = createAdminClient();
  const { error } = await admin.from("combos").delete().eq("id", comboId).eq("business_id", businessId);
  if (error) return { error: GENERIC_ERROR };
  return { ok: true };
}

// ── images (Supabase Storage, tenant-scoped) ────────────────────────────────

async function persistImage(
  businessId: string,
  entityId: string,
  file: unknown,
  table: "menu_items" | "combos",
): Promise<MenuActionState> {
  if (!(typeof File !== "undefined" && file instanceof File)) {
    return { fieldErrors: { image: ["Choose an image file."] } };
  }
  if (!IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number])) {
    return { fieldErrors: { image: ["Images must be JPEG, PNG or WebP."] } };
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return { fieldErrors: { image: ["Images must be 5 MB or smaller."] } };
  }
  const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${businessId}/${entityId}/${randomUUID()}.${extension}`;

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from(table)
    .select("image_path")
    .eq("id", entityId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!existing) return { error: "Not found in this business." };

  const { error: uploadError } = await admin.storage
    .from("menu-media")
    .upload(path, file, { contentType: file.type, cacheControl: "3600" });
  if (uploadError) return { error: "Image upload failed. Please try again." };

  const { error } = await admin.from(table).update({ image_path: path }).eq("id", entityId);
  if (error) {
    await admin.storage.from("menu-media").remove([path]);
    return { error: GENERIC_ERROR };
  }
  if (existing.image_path) {
    await admin.storage.from("menu-media").remove([existing.image_path]);
  }
  return { ok: true };
}

export async function uploadProductImageAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const productId = String(formData.get("productId") ?? "");
  if (!(await inBusiness("menu_items", productId, businessId))) {
    return { error: "Product not found in this business." };
  }
  return persistImage(businessId, productId, formData.get("image"), "menu_items");
}

export async function removeProductImageAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const productId = String(formData.get("productId") ?? "");
  if (!(await inBusiness("menu_items", productId, businessId))) {
    return { error: "Product not found in this business." };
  }
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("menu_items")
    .select("image_path")
    .eq("id", productId)
    .maybeSingle();
  await admin.from("menu_items").update({ image_path: null }).eq("id", productId);
  if (existing?.image_path) {
    await admin.storage.from("menu-media").remove([existing.image_path]);
  }
  return { ok: true };
}

export async function uploadComboImageAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const comboId = String(formData.get("comboId") ?? "");
  if (!(await inBusiness("combos", comboId, businessId))) {
    return { error: "Combo not found in this business." };
  }
  return persistImage(businessId, comboId, formData.get("image"), "combos");
}

export async function removeComboImageAction(
  _previous: MenuActionState | undefined,
  formData: FormData,
): Promise<MenuActionState> {
  const businessId = String(formData.get("businessId") ?? "");
  const auth = await authorizeMenuWrite(businessId);
  if ("error" in auth) return { error: auth.error };

  const comboId = String(formData.get("comboId") ?? "");
  if (!(await inBusiness("combos", comboId, businessId))) {
    return { error: "Combo not found in this business." };
  }
  const admin = createAdminClient();
  const { data: existing } = await admin.from("combos").select("image_path").eq("id", comboId).maybeSingle();
  await admin.from("combos").update({ image_path: null }).eq("id", comboId);
  if (existing?.image_path) {
    await admin.storage.from("menu-media").remove([existing.image_path]);
  }
  return { ok: true };
}
