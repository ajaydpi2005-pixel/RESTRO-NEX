/**
 * Phase 11 — Kitchen Display System constants.
 *
 * Item lifecycle (kitchen_items / order_items.kitchen_status):
 *   new → accepted → preparing → ready → completed
 * `completed` and `cancelled` leave the board. The POS owns order status;
 * the KDS never moves an order itself.
 */

export const KITCHEN_STATUSES = ["new", "accepted", "preparing", "ready"] as const;
export type KitchenStatus = (typeof KITCHEN_STATUSES)[number];

/** Statuses that keep an item on the board. completed/cancelled rows are history. */
export const ACTIVE_KITCHEN_STATUSES: readonly string[] = KITCHEN_STATUSES;

export function isActiveKitchenStatus(status: string): status is KitchenStatus {
  return ACTIVE_KITCHEN_STATUSES.includes(status);
}

/** Statuses an item can be moved TO by the board. */
export const KITCHEN_TARGETS = ["accepted", "preparing", "ready", "completed"] as const;
export type KitchenTarget = (typeof KITCHEN_TARGETS)[number];

export const STATUS_LABEL: Record<KitchenStatus, string> = {
  new: "New",
  accepted: "Accepted",
  preparing: "Preparing",
  ready: "Ready",
};

/** The next move a cook makes on an item or ticket in each status. */
export const NEXT_TARGET: Record<KitchenStatus, KitchenTarget> = {
  new: "accepted",
  accepted: "preparing",
  preparing: "ready",
  ready: "completed",
};

export const ACTION_LABEL: Record<KitchenStatus, string> = {
  new: "Accept",
  accepted: "Start",
  preparing: "Ready",
  ready: "Done",
};

/** Order/item age thresholds. Below WARN is calm, WARN–LATE amber, LATE red. */
export const WARN_AFTER_MS = 8 * 60_000;
export const LATE_AFTER_MS = 15 * 60_000;

export const UNROUTED_FILTER = "unrouted";
export const ALL_FILTER = "all";

export const EVENT_REASON_LABEL: Record<string, string> = {
  order_cancelled: "Order cancelled",
  item_cancelled: "Item cancelled",
  item_removed: "Item removed from order",
};

export const ORDER_TYPE_LABEL: Record<string, string> = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  delivery: "Delivery",
};
