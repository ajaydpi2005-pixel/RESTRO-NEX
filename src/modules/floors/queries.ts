import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 9 — Dining floors, sections and tables (reads).
 *
 * Pages authorise with requirePermission/getViewerAbilities BEFORE calling
 * these helpers; the queries themselves use the service client so that RLS
 * stays the outer defence rather than the only defence.
 */

export interface FloorRow {
  id: string;
  name: string;
  sortOrder: number;
}

export interface SectionRow {
  id: string;
  floorId: string;
  name: string;
  sortOrder: number;
}

export interface TableCard {
  id: string;
  sectionId: string;
  label: string;
  capacity: number;
  isActive: boolean;
  sortOrder: number;
  status: "available" | "occupied" | "reserved";
  reservationNote: string | null;
  /** Active order anchored to this table (occupied tables only). */
  order: {
    id: string;
    orderNumber: number;
    status: string;
    paymentStatus: "unpaid" | "partial" | "paid" | "refunded";
    totalMinor: number;
    itemCount: number;
    createdAt: string;
  } | null;
}

export interface FloorPlan {
  floors: FloorRow[];
  sections: SectionRow[];
  tables: TableCard[];
}

const ACTIVE_ORDER_STATUSES = ["open", "held", "placed", "preparing", "ready"];

/**
 * Full floor plan for one outlet: floors → sections → tables, each occupied
 * table enriched with the order currently anchored to it.
 */
export async function loadFloorPlan(outletId: string): Promise<FloorPlan> {
  const admin = createAdminClient();

  const [floorsRes, sectionsRes, tablesRes] = await Promise.all([
    admin
      .from("floors")
      .select("id, name, sort_order")
      .eq("outlet_id", outletId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    admin
      .from("dining_sections")
      .select("id, floor_id, name, sort_order")
      .eq("outlet_id", outletId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    admin
      .from("dining_tables")
      .select("id, section_id, label, capacity, is_active, sort_order, status, current_order_id, reservation_note")
      .eq("outlet_id", outletId)
      .order("sort_order", { ascending: true })
      .order("label", { ascending: true }),
  ]);

  const tables = tablesRes.data ?? [];
  const orderIds = [
    ...new Set(
      tables
        .map((t) => t.current_order_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const ordersById = new Map<string, NonNullable<TableCard["order"]>>();
  if (orderIds.length > 0) {
    const [{ data: orders }, { data: lines }] = await Promise.all([
      admin
        .from("orders")
        .select("id, order_number, status, payment_status, total_minor, created_at")
        .in("id", orderIds),
      admin.from("order_items").select("order_id").in("order_id", orderIds),
    ]);
    const lineCounts = new Map<string, number>();
    for (const line of lines ?? []) {
      lineCounts.set(line.order_id, (lineCounts.get(line.order_id) ?? 0) + 1);
    }
    for (const o of orders ?? []) {
      ordersById.set(o.id, {
        id: o.id,
        orderNumber: o.order_number,
        status: o.status,
        paymentStatus: o.payment_status as "unpaid" | "partial" | "paid" | "refunded",
        totalMinor: Number(o.total_minor),
        itemCount: lineCounts.get(o.id) ?? 0,
        createdAt: o.created_at,
      });
    }
  }

  return {
    floors: (floorsRes.data ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      sortOrder: f.sort_order,
    })),
    sections: (sectionsRes.data ?? []).map((s) => ({
      id: s.id,
      floorId: s.floor_id,
      name: s.name,
      sortOrder: s.sort_order,
    })),
    tables: tables.map((t) => ({
      id: t.id,
      sectionId: t.section_id,
      label: t.label,
      capacity: t.capacity,
      isActive: t.is_active,
      sortOrder: t.sort_order,
      status: (t.status as TableCard["status"]) ?? "available",
      reservationNote: t.reservation_note,
      order:
        t.current_order_id && ordersById.get(t.current_order_id)
          ? ordersById.get(t.current_order_id)!
          : null,
    })),
  };
}

/** Candidate tables for merge/split pickers: same outlet, not occupied. */
export async function loadFreeTables(outletId: string): Promise<
  { id: string; label: string; sectionName: string }[]
> {
  const admin = createAdminClient();
  const { data: sections } = await admin
    .from("dining_sections")
    .select("id, name")
    .eq("outlet_id", outletId);
  const sectionNames = new Map((sections ?? []).map((s) => [s.id, s.name]));
  const { data: tables } = await admin
    .from("dining_tables")
    .select("id, label, section_id, sort_order")
    .eq("outlet_id", outletId)
    .eq("is_active", true)
    .neq("status", "occupied")
    .order("sort_order", { ascending: true });
  return (tables ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    sectionName: (t.section_id && sectionNames.get(t.section_id)) || "Tables",
  }));
}

export interface SplitItem {
  id: string;
  name: string;
  quantity: number;
  lineTotalMinor: number;
}

/** Active dine-in orders on this outlet (merge targets / order browser). */
export async function loadActiveDineInOrders(outletId: string): Promise<
  { id: string; orderNumber: number; tableId: string | null; tableLabel: string | null; status: string; totalMinor: number }[]
> {
  const admin = createAdminClient();
  const { data: orders } = await admin
    .from("orders")
    .select("id, order_number, table_id, status, total_minor")
    .eq("outlet_id", outletId)
    .eq("order_type", "dine_in")
    .in("status", ACTIVE_ORDER_STATUSES)
    .order("order_number", { ascending: true });
  const rows = orders ?? [];
  const tableIds = [...new Set(rows.map((o) => o.table_id).filter((t): t is string => Boolean(t)))];
  const { data: tables } =
    tableIds.length > 0
      ? await admin.from("dining_tables").select("id, label").in("id", tableIds)
      : { data: [] };
  const tableLabels = new Map((tables ?? []).map((t) => [t.id, t.label]));
  return rows.map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    tableId: o.table_id,
    tableLabel: o.table_id ? tableLabels.get(o.table_id) ?? null : null,
    status: o.status,
    totalMinor: Number(o.total_minor),
  }));
}

/** Items of every active dine-in order on this outlet (split-bill pickers). */
export async function loadActiveOrderItems(outletId: string): Promise<Record<string, SplitItem[]>> {
  const admin = createAdminClient();
  const { data: orders } = await admin
    .from("orders")
    .select("id")
    .eq("outlet_id", outletId)
    .eq("order_type", "dine_in")
    .in("status", ACTIVE_ORDER_STATUSES);
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length === 0) return {};
  const { data: items } = await admin
    .from("order_items")
    .select("id, order_id, name, quantity, line_total_minor, position")
    .in("order_id", orderIds)
    .order("position", { ascending: true });
  const grouped: Record<string, SplitItem[]> = {};
  for (const item of items ?? []) {
    (grouped[item.order_id] ??= []).push({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      lineTotalMinor: Number(item.line_total_minor),
    });
  }
  return grouped;
}
