/**
 * Phase 12 — how a sent item's kitchen progress reads on the waiter's screen.
 * The kitchen values come from order_items.kitchen_status (Phase 11).
 */

export const KITCHEN_ITEM_LABEL: Record<string, string> = {
  pending: "Not sent",
  new: "Sent",
  accepted: "Accepted",
  preparing: "Cooking",
  ready: "Ready",
  completed: "Served",
  cancelled: "Cancelled",
};

export type KitchenTone = "muted" | "info" | "progress" | "ready" | "done" | "cancelled";

export function kitchenTone(status: string): KitchenTone {
  switch (status) {
    case "new":
    case "accepted":
      return "info";
    case "preparing":
      return "progress";
    case "ready":
      return "ready";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    default:
      return "muted";
  }
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  held: "Held",
  placed: "Sent",
  preparing: "Preparing",
  ready: "Ready",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Order states in which a waiter may add items (a new round or a fresh draft). */
export const SENT_ORDER_STATES = ["placed", "preparing", "ready"] as const;

export function isSentOrderState(status: string): boolean {
  return (SENT_ORDER_STATES as readonly string[]).includes(status);
}

/** Open or held orders are still being built at the POS — waiters only view them. */
export function isPosDraftState(status: string): boolean {
  return status === "open" || status === "held";
}

export function readyItemCount(items: ReadonlyArray<{ kitchenStatus: string; quantity: number }>): number {
  return items.reduce((sum, item) => (item.kitchenStatus === "ready" ? sum + item.quantity : sum), 0);
}
