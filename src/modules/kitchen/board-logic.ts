import {
  ALL_FILTER,
  KITCHEN_STATUSES,
  LATE_AFTER_MS,
  UNROUTED_FILTER,
  WARN_AFTER_MS,
  type KitchenStatus,
} from "./constants";

/**
 * Phase 11 — pure board logic (no React, no I/O). Everything the screen
 * shows is derived here so it can be unit-tested.
 */

/** Row shape of public.kitchen_items (money-free projection). */
export interface KitchenItemRow {
  id: string;
  business_id: string;
  outlet_id: string;
  order_id: string;
  order_number: number;
  order_type: string;
  table_label: string | null;
  station_id: string | null;
  item_name: string;
  quantity: number;
  item_notes: string | null;
  modifiers: { name: string; quantity: number }[];
  kitchen_status: KitchenStatus;
  kitchen_status_at: string;
  sent_at: string;
  priority: boolean;
  position: number;
  updated_at: string;
}

/** Row shape of public.kitchen_events. */
export interface KitchenEventRow {
  id: string;
  outlet_id: string;
  order_id: string;
  order_number: number;
  station_id: string | null;
  item_name: string;
  quantity: number;
  reason: "order_cancelled" | "item_cancelled" | "item_removed";
  created_at: string;
  acknowledged_at: string | null;
}

export interface StationRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
}

export type TimerTone = "calm" | "warn" | "late";

export function timerTone(elapsedMs: number): TimerTone {
  if (elapsedMs >= LATE_AFTER_MS) return "late";
  if (elapsedMs >= WARN_AFTER_MS) return "warn";
  return "calm";
}

/** m:ss under an hour, h:mm:ss beyond. Negative input clamps to zero. */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

export function statusRank(status: KitchenStatus): number {
  return KITCHEN_STATUSES.indexOf(status);
}

/** The least-advanced status in a set: a ticket is only as far along as its slowest item. */
export function minStatus(statuses: readonly KitchenStatus[]): KitchenStatus {
  let lowest = statuses[0] ?? "new";
  for (const status of statuses) {
    if (statusRank(status) < statusRank(lowest)) lowest = status;
  }
  return lowest;
}

/** Station an item is shown under. Inactive or missing stations fall back to Unrouted. */
export function effectiveStationId(
  item: Pick<KitchenItemRow, "station_id">,
  activeStationIds: ReadonlySet<string>,
): string | null {
  if (item.station_id && activeStationIds.has(item.station_id)) return item.station_id;
  return null;
}

export interface Ticket {
  /** Stable key: one ticket per (order, station) lane. */
  key: string;
  orderId: string;
  orderNumber: number;
  orderType: string;
  tableLabel: string | null;
  stationId: string | null;
  /** Least-advanced item status; decides the column. */
  status: KitchenStatus;
  priority: boolean;
  /** Oldest item send time. Drives the order timer. */
  sentAt: string;
  items: KitchenItemRow[];
}

export function ticketKey(orderId: string, stationId: string | null): string {
  return `${orderId}|${stationId ?? "unrouted"}`;
}

export function matchesFilter(
  stationId: string | null,
  filter: string,
): boolean {
  if (filter === ALL_FILTER) return true;
  if (filter === UNROUTED_FILTER) return stationId === null;
  return stationId === filter;
}

/**
 * Group active items into station tickets. Sorting: priority first, then the
 * oldest send time, then order number.
 */
export function buildTickets(
  items: readonly KitchenItemRow[],
  activeStationIds: ReadonlySet<string>,
  filter: string = ALL_FILTER,
): Ticket[] {
  const groups = new Map<string, { head: KitchenItemRow; stationId: string | null; items: KitchenItemRow[] }>();

  for (const item of items) {
    const stationId = effectiveStationId(item, activeStationIds);
    if (!matchesFilter(stationId, filter)) continue;
    const key = ticketKey(item.order_id, stationId);
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, { head: item, stationId, items: [item] });
    }
  }

  const tickets: Ticket[] = [];
  for (const [key, group] of groups) {
    const sorted = [...group.items].sort((a, b) => a.position - b.position || a.item_name.localeCompare(b.item_name));
    const sentAt = sorted.reduce(
      (earliest, item) => (item.sent_at < earliest ? item.sent_at : earliest),
      sorted[0]!.sent_at,
    );
    tickets.push({
      key,
      orderId: group.head.order_id,
      orderNumber: group.head.order_number,
      orderType: group.head.order_type,
      tableLabel: group.head.table_label,
      stationId: group.stationId,
      status: minStatus(sorted.map((item) => item.kitchen_status)),
      priority: sorted.some((item) => item.priority),
      sentAt,
      items: sorted,
    });
  }

  return tickets.sort(
    (a, b) =>
      Number(b.priority) - Number(a.priority) ||
      a.sentAt.localeCompare(b.sentAt) ||
      a.orderNumber - b.orderNumber ||
      a.key.localeCompare(b.key),
  );
}

/** Tickets split into the four board columns, in lifecycle order. */
export function ticketsByColumn(tickets: readonly Ticket[]): Record<KitchenStatus, Ticket[]> {
  const columns: Record<KitchenStatus, Ticket[]> = { new: [], accepted: [], preparing: [], ready: [] };
  for (const ticket of tickets) columns[ticket.status].push(ticket);
  return columns;
}

/** Item counts per filter, for the station tabs. */
export function stationCounts(
  items: readonly KitchenItemRow[],
  activeStationIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  counts.set(ALL_FILTER, items.length);
  let unrouted = 0;
  for (const item of items) {
    const stationId = effectiveStationId(item, activeStationIds);
    if (stationId) {
      counts.set(stationId, (counts.get(stationId) ?? 0) + 1);
    } else {
      unrouted += 1;
    }
  }
  counts.set(UNROUTED_FILTER, unrouted);
  return counts;
}

/** Items a ticket bump moves: only those at the ticket's current status. */
export function bumpableItems(ticket: Ticket): KitchenItemRow[] {
  return ticket.items.filter((item) => item.kitchen_status === ticket.status);
}
