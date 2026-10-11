import { createAdminClient } from "@/lib/supabase/admin";
import { expiryState, foodCostPct, marginPct, recipeCostMinor, stockStatus, type ExpiryState, type StockStatus } from "@/modules/inventory/math";

/**
 * Phase 13 — inventory reads. Pages authorise first (inventory.view for stock
 * and costs, menu.view for recipes); these loaders use the service client.
 */

export interface IngredientRow {
  id: string;
  name: string;
  unit: string;
  costPerUnit: number;
  minimumStock: number | null;
  maximumStock: number | null;
  active: boolean;
}

export interface StockRow extends IngredientRow {
  onHand: number;
  status: StockStatus;
  nearestExpiry: string | null;
}

export interface BatchRow {
  id: string;
  ingredientName: string;
  unit: string;
  batchCode: string | null;
  remaining: number;
  unitCost: number;
  expiresOn: string | null;
  state: ExpiryState;
}

export interface MovementRow {
  id: string;
  createdAt: string;
  ingredientName: string;
  unit: string;
  kind: string;
  qty: number;
  valueMinor: number;
  reason: string | null;
}

export interface FoodCostSummary {
  costMinor: number;
  salesMinor: number;
  orders: number;
  pct: number | null;
}

export interface RecipeRow {
  menuItemId: string;
  name: string;
  priceMinor: number;
  isAvailable: boolean;
  lines: { ingredientId: string; name: string; unit: string; quantity: number; costPerUnit: number }[];
  costMinor: number;
  marginPct: number | null;
}

export interface TransferRow {
  id: string;
  createdAt: string;
  fromName: string;
  toName: string;
  note: string | null;
  lines: string[];
}

/** Today's date in the business timezone (IST), as YYYY-MM-DD. */
export function businessToday(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export async function loadIngredients(businessId: string): Promise<IngredientRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ingredients")
    .select("id, name, unit, cost_per_unit, minimum_stock, maximum_stock, active")
    .eq("business_id", businessId)
    .order("name", { ascending: true });
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    unit: row.unit,
    costPerUnit: Number(row.cost_per_unit),
    minimumStock: row.minimum_stock === null ? null : Number(row.minimum_stock),
    maximumStock: row.maximum_stock === null ? null : Number(row.maximum_stock),
    active: row.active,
  }));
}

export async function loadLiveBatches(
  outletId: string,
  today: string,
  limit: number | null = 300,
  ingredientId?: string,
): Promise<(BatchRow & { ingredientId: string })[]> {
  const admin = createAdminClient();
  let query = admin
    .from("inventory_batches")
    .select("id, ingredient_id, batch_code, remaining_qty, unit_cost, expires_on, ingredients(name, unit)")
    .eq("outlet_id", outletId)
    .gt("remaining_qty", 0)
    .order("expires_on", { ascending: true, nullsFirst: false });
  if (ingredientId) query = query.eq("ingredient_id", ingredientId);
  if (limit !== null) query = query.limit(limit);
  const { data } = await query;
  return (data ?? []).map((row) => {
    const ing = Array.isArray(row.ingredients) ? row.ingredients[0] : row.ingredients;
    return {
      id: row.id,
      ingredientId: row.ingredient_id,
      ingredientName: ing?.name ?? "Unknown",
      unit: ing?.unit ?? "",
      batchCode: row.batch_code,
      remaining: Number(row.remaining_qty),
      unitCost: Number(row.unit_cost),
      expiresOn: row.expires_on,
      state: expiryState(row.expires_on, today),
    };
  });
}

export async function loadStockLevels(
  businessId: string,
  outletId: string,
  today: string,
): Promise<{ rows: StockRow[]; batches: BatchRow[] }> {
  const admin = createAdminClient();
  // every live batch feeds the nearest-expiry column; the display list is capped
  const [ingredients, stock, allBatches] = await Promise.all([
    loadIngredients(businessId),
    admin.from("inventory_stock").select("ingredient_id, on_hand").eq("outlet_id", outletId),
    loadLiveBatches(outletId, today, null),
  ]);
  const onHand = new Map((stock.data ?? []).map((s) => [s.ingredient_id, Number(s.on_hand)]));
  const nearest = new Map<string, string>();
  for (const batch of allBatches) {
    if (!batch.expiresOn) continue;
    const current = nearest.get(batch.ingredientId);
    if (!current || batch.expiresOn < current) nearest.set(batch.ingredientId, batch.expiresOn);
  }

  const rows: StockRow[] = ingredients
    .filter((ing) => ing.active || onHand.has(ing.id))
    .map((ing) => {
      const level = onHand.get(ing.id) ?? 0;
      return {
        ...ing,
        onHand: level,
        status: stockStatus({ onHand: level, minimum: ing.minimumStock, maximum: ing.maximumStock }),
        nearestExpiry: nearest.get(ing.id) ?? null,
      };
    });
  return { rows, batches: allBatches.slice(0, 300) };
}

export async function loadRecentMovements(outletId: string, limit = 25): Promise<MovementRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("inventory_movements")
    .select("id, created_at, kind, qty, value_minor, reason, ingredients(name, unit)")
    .eq("outlet_id", outletId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => {
    const ing = Array.isArray(row.ingredients) ? row.ingredients[0] : row.ingredients;
    return {
      id: row.id,
      createdAt: row.created_at,
      ingredientName: ing?.name ?? "Unknown",
      unit: ing?.unit ?? "",
      kind: row.kind,
      qty: Number(row.qty),
      valueMinor: Math.round(Number(row.value_minor)),
      reason: row.reason,
    };
  });
}

/**
 * Actual food cost for completed orders since `sinceIso`: the cost posted at
 * batch value, against the subtotals of the same orders.
 */
export async function loadFoodCostSummary(outletId: string, days = 30): Promise<FoodCostSummary> {
  const admin = createAdminClient();
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: postings } = await admin
    .from("inventory_postings")
    .select("order_id, cost_minor")
    .eq("outlet_id", outletId)
    .gte("posted_at", sinceIso);
  const list = postings ?? [];
  if (list.length === 0) return { costMinor: 0, salesMinor: 0, orders: 0, pct: null };

  const { data: orders } = await admin
    .from("orders")
    .select("id, subtotal_minor")
    .in("id", list.map((p) => p.order_id));
  const subtotal = new Map((orders ?? []).map((o) => [o.id, Number(o.subtotal_minor)]));
  const costMinor = list.reduce((sum, p) => sum + Number(p.cost_minor), 0);
  const salesMinor = list.reduce((sum, p) => sum + (subtotal.get(p.order_id) ?? 0), 0);
  return {
    costMinor: Math.round(costMinor),
    salesMinor,
    orders: list.length,
    pct: foodCostPct(costMinor, salesMinor),
  };
}

export async function loadReconciliation(
  actorId: string,
  outletId: string,
): Promise<{ checked: number; mismatches: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("inventory_reconcile", { p_actor: actorId, p_outlet_id: outletId });
  if (error || !data) return { checked: 0, mismatches: 0 };
  const rows = data as { consistent: boolean }[];
  return { checked: rows.length, mismatches: rows.filter((r) => !r.consistent).length };
}

export async function loadRecipes(businessId: string): Promise<RecipeRow[]> {
  const admin = createAdminClient();
  const [items, recipes, ingredients] = await Promise.all([
    admin
      .from("menu_items")
      .select("id, name, price_minor, is_available")
      .eq("business_id", businessId)
      .order("name", { ascending: true }),
    admin.from("recipes").select("id, menu_item_id").eq("business_id", businessId),
    loadIngredients(businessId),
  ]);
  const recipeByItem = new Map((recipes.data ?? []).map((r) => [r.menu_item_id, r.id]));
  const recipeIds = [...recipeByItem.values()];
  const { data: lines } = recipeIds.length
    ? await admin.from("recipe_ingredients").select("recipe_id, ingredient_id, quantity").in("recipe_id", recipeIds)
    : { data: [] as { recipe_id: string; ingredient_id: string; quantity: number }[] };
  const ingById = new Map(ingredients.map((i) => [i.id, i]));

  return (items.data ?? []).map((item) => {
    const recipeId = recipeByItem.get(item.id);
    const recipeLines = (lines ?? [])
      .filter((l) => l.recipe_id === recipeId)
      .map((l) => {
        const ing = ingById.get(l.ingredient_id);
        return {
          ingredientId: l.ingredient_id,
          name: ing?.name ?? "Unknown",
          unit: ing?.unit ?? "",
          quantity: Number(l.quantity),
          costPerUnit: ing?.costPerUnit ?? 0,
        };
      });
    const costMinor = recipeCostMinor(recipeLines.map((l) => ({ quantity: l.quantity, costPerUnit: l.costPerUnit })));
    const priceMinor = Number(item.price_minor);
    return {
      menuItemId: item.id,
      name: item.name,
      priceMinor,
      isAvailable: item.is_available,
      lines: recipeLines,
      costMinor,
      marginPct: marginPct(priceMinor, costMinor),
    };
  });
}

export async function loadTransfers(businessId: string, outletNames: Map<string, string>): Promise<TransferRow[]> {
  const admin = createAdminClient();
  const { data: transfers } = await admin
    .from("stock_transfers")
    .select("id, created_at, from_outlet_id, to_outlet_id, note")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(20);
  const list = transfers ?? [];
  if (list.length === 0) return [];
  const { data: moves } = await admin
    .from("inventory_movements")
    .select("transfer_id, qty, ingredients(name, unit)")
    .in("transfer_id", list.map((t) => t.id))
    .eq("kind", "transfer_out");
  return list.map((t) => ({
    id: t.id,
    createdAt: t.created_at,
    fromName: outletNames.get(t.from_outlet_id) ?? "Outlet",
    toName: outletNames.get(t.to_outlet_id) ?? "Outlet",
    note: t.note,
    lines: (moves ?? [])
      .filter((m) => m.transfer_id === t.id)
      .map((m) => {
        const ing = Array.isArray(m.ingredients) ? m.ingredients[0] : m.ingredients;
        return `${ing?.name ?? "Item"} ${Math.abs(Number(m.qty))} ${ing?.unit ?? ""}`;
      }),
  }));
}
