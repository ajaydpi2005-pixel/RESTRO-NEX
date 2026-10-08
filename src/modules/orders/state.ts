/**
 * Phase 8 — Order state machine (single source of truth for transitions).
 *
 *   open → held ↔ open → placed → preparing → ready → completed
 *   open / held / placed / preparing → cancelled
 *
 * `ready → completed` additionally requires the order to be fully paid
 * (enforced in transition_order_status). Payments are recorded from the
 * order's billing panel.
 */

export const ORDER_STATES = [
  "open",
  "held",
  "placed",
  "preparing",
  "ready",
  "completed",
  "cancelled",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  open: ["held", "placed", "cancelled"],
  held: ["open", "placed", "cancelled"],
  placed: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed"],
  completed: [],
  cancelled: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: OrderState): readonly OrderState[] {
  return TRANSITIONS[from];
}

export function isOrderState(value: unknown): value is OrderState {
  return typeof value === "string" && (ORDER_STATES as readonly string[]).includes(value);
}

export const ORDER_STATE_LABELS: Record<OrderState, string> = {
  open: "Open",
  held: "On hold",
  placed: "Placed",
  preparing: "Preparing",
  ready: "Ready",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** States that are still "in flight" for dashboards/filters. */
export const ACTIVE_ORDER_STATES: readonly OrderState[] = [
  "open",
  "held",
  "placed",
  "preparing",
  "ready",
];

export const ORDER_TYPES = ["dine_in", "takeaway", "delivery"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  delivery: "Delivery",
};
