import { createAdminClient } from "@/lib/supabase/admin";
import { loadFloorPlan, type FloorPlan } from "@/modules/floors/queries";

/**
 * Phase 12 — read models for the waiter screens. Callers verify the session
 * and `orders.view` / `orders.manage` for the outlet before calling these.
 */

export interface WaiterOrderItem {
  id: string;
  name: string;
  quantity: number;
  itemNotes: string | null;
  kitchenStatus: string;
  modifiers: string[];
}

export interface WaiterOrderView {
  id: string;
  orderNumber: number;
  status: string;
  totalMinor: number;
  subtotalMinor: number;
  billRequestedAt: string | null;
  items: WaiterOrderItem[];
}

export async function loadWaiterOrder(
  outletId: string,
  orderId: string,
): Promise<WaiterOrderView | null> {
  const admin = createAdminClient();

  const { data: order } = await admin
    .from("orders")
    .select("id, outlet_id, order_number, status, total_minor, subtotal_minor, bill_requested_at")
    .eq("id", orderId)
    .eq("outlet_id", outletId)
    .maybeSingle();
  if (!order) return null;

  const { data: lines } = await admin
    .from("order_items")
    .select("id, name, quantity, item_notes, kitchen_status, position")
    .eq("order_id", order.id)
    .order("position", { ascending: true });
  const lineRows = lines ?? [];
  const lineIds = lineRows.map((l) => l.id);

  const modifierNames = new Map<string, string[]>();
  if (lineIds.length > 0) {
    const { data: mods } = await admin
      .from("order_item_modifiers")
      .select("order_item_id, name, quantity")
      .in("order_item_id", lineIds);
    for (const m of mods ?? []) {
      const label = m.quantity > 1 ? `${m.name} ×${m.quantity}` : m.name;
      modifierNames.set(m.order_item_id, [...(modifierNames.get(m.order_item_id) ?? []), label]);
    }
  }

  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    totalMinor: Number(order.total_minor),
    subtotalMinor: Number(order.subtotal_minor),
    billRequestedAt: order.bill_requested_at ?? null,
    items: lineRows.map((l) => ({
      id: l.id,
      name: l.name,
      quantity: l.quantity,
      itemNotes: l.item_notes ?? null,
      kitchenStatus: l.kitchen_status,
      modifiers: modifierNames.get(l.id) ?? [],
    })),
  };
}

export interface WaiterFloorView {
  plan: FloorPlan;
  /** active order id → number of its items the kitchen has marked ready */
  readyByOrder: Record<string, number>;
}

export async function loadWaiterFloor(outletId: string): Promise<WaiterFloorView> {
  const plan = await loadFloorPlan(outletId);
  const orderIds = plan.tables.map((t) => t.order?.id).filter((id): id is string => Boolean(id));

  const readyByOrder: Record<string, number> = {};
  if (orderIds.length > 0) {
    const admin = createAdminClient();
    const { data: ready } = await admin
      .from("order_items")
      .select("order_id, quantity")
      .in("order_id", orderIds)
      .eq("kitchen_status", "ready");
    for (const row of ready ?? []) {
      readyByOrder[row.order_id] = (readyByOrder[row.order_id] ?? 0) + row.quantity;
    }
  }

  return { plan, readyByOrder };
}
