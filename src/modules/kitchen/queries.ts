import { createAdminClient } from "@/lib/supabase/admin";
import type { KitchenEventRow, KitchenItemRow, StationRow } from "./board-logic";
import { ACTIVE_KITCHEN_STATUSES } from "./constants";

/**
 * Phase 11 — kitchen read models. Reads run through the service client AFTER
 * the caller has passed requirePermission for the outlet. The board reads only
 * the money-free projection (kitchen_items / kitchen_events).
 */

export interface BoardSnapshot {
  items: KitchenItemRow[];
  events: KitchenEventRow[];
  stations: StationRow[];
}

export async function loadBoardSnapshot(outletId: string): Promise<BoardSnapshot> {
  const admin = createAdminClient();

  const [itemsRes, eventsRes, stationsRes] = await Promise.all([
    admin
      .from("kitchen_items")
      .select(
        "id, business_id, outlet_id, order_id, order_number, order_type, table_label, station_id, item_name, quantity, item_notes, modifiers, kitchen_status, kitchen_status_at, sent_at, priority, position, updated_at",
      )
      .eq("outlet_id", outletId)
      .in("kitchen_status", ACTIVE_KITCHEN_STATUSES as string[])
      .order("sent_at", { ascending: true })
      .limit(1000),
    admin
      .from("kitchen_events")
      .select(
        "id, outlet_id, order_id, order_number, station_id, item_name, quantity, reason, created_at, acknowledged_at",
      )
      .eq("outlet_id", outletId)
      .is("acknowledged_at", null)
      .order("created_at", { ascending: false })
      .limit(100),
    admin
      .from("kitchen_stations")
      .select("id, name, description, is_active, sort_order")
      .eq("outlet_id", outletId)
      .order("sort_order", { ascending: true }),
  ]);

  return {
    items: (itemsRes.data ?? []) as unknown as KitchenItemRow[],
    events: (eventsRes.data ?? []) as unknown as KitchenEventRow[],
    stations: (stationsRes.data ?? []) as StationRow[],
  };
}

export interface RoutingData {
  stations: StationRow[];
  categories: { id: string; name: string }[];
  items: { id: string; name: string; category_id: string }[];
  combos: { id: string; name: string }[];
  routes: { target_type: "category" | "item" | "combo"; target_id: string; station_id: string }[];
}

/** Menu targets and current routes for one outlet (routing manager). */
export async function loadRoutingData(businessId: string, outletId: string): Promise<RoutingData> {
  const admin = createAdminClient();

  const [stations, categories, items, combos, routes] = await Promise.all([
    admin
      .from("kitchen_stations")
      .select("id, name, description, is_active, sort_order")
      .eq("outlet_id", outletId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    admin.from("menu_categories").select("id, name").eq("business_id", businessId).order("name"),
    admin.from("menu_items").select("id, name, category_id").eq("business_id", businessId).order("name"),
    admin.from("combos").select("id, name").eq("business_id", businessId).order("name"),
    admin
      .from("kitchen_routes")
      .select("target_type, target_id, station_id")
      .eq("outlet_id", outletId),
  ]);

  return {
    stations: (stations.data ?? []) as StationRow[],
    categories: categories.data ?? [],
    items: items.data ?? [],
    combos: combos.data ?? [],
    routes: (routes.data ?? []) as RoutingData["routes"],
  };
}

/** Resolve an outlet to its business (server-side; never trusts the client). */
export async function outletBusinessId(outletId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("outlets").select("business_id").eq("id", outletId).maybeSingle();
  return data?.business_id ?? null;
}
