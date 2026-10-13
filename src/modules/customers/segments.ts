/**
 * Phase 15 — customer segments. Computed on read from completed orders, so the
 * label always reflects the current data. Pure: no database or clock access.
 */

export type CustomerSegment =
  "no_orders" | "lapsed" | "at_risk" | "new" | "vip" | "regular" | "occasional";

export const SEGMENT_LABELS: Record<CustomerSegment, string> = {
  no_orders: "No orders yet",
  lapsed: "Lapsed",
  at_risk: "At risk",
  new: "New",
  vip: "VIP",
  regular: "Regular",
  occasional: "Occasional",
};

export const SEGMENT_HINTS: Record<CustomerSegment, string> = {
  no_orders: "No completed order yet.",
  lapsed: "No order for over 180 days.",
  at_risk: "No order for 61 to 180 days.",
  new: "Their first order, within the last 30 days.",
  vip: "10 or more orders, or ₹20,000 or more in net spend, and ordered in the last 60 days.",
  regular: "3 or more orders, ordered in the last 60 days.",
  occasional: "One or two orders, or older orders with no recent activity.",
};

export const SEGMENT_THRESHOLDS = {
  lapsedDays: 180,
  atRiskDays: 60,
  newDays: 30,
  vipOrders: 10,
  vipSpendMinor: 2_000_000,
  regularOrders: 3,
} as const;

export const SEGMENT_ORDER: CustomerSegment[] = [
  "vip",
  "regular",
  "new",
  "occasional",
  "at_risk",
  "lapsed",
  "no_orders",
];

export interface SegmentInput {
  orderCount: number;
  totalSpendMinor: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Recency decides first: a lapsed VIP is lapsed. Then "new" needs exactly one
 * order inside the window. Then frequency and spend.
 */
export function segmentFor(input: SegmentInput): CustomerSegment {
  if (input.orderCount <= 0 || !input.lastOrderAt || !input.firstOrderAt) return "no_orders";

  const daysSinceLast = (input.now.getTime() - input.lastOrderAt.getTime()) / DAY_MS;
  const daysSinceFirst = (input.now.getTime() - input.firstOrderAt.getTime()) / DAY_MS;

  if (daysSinceLast > SEGMENT_THRESHOLDS.lapsedDays) return "lapsed";
  if (daysSinceLast > SEGMENT_THRESHOLDS.atRiskDays) return "at_risk";
  if (input.orderCount === 1 && daysSinceFirst <= SEGMENT_THRESHOLDS.newDays) return "new";
  if (
    input.orderCount >= SEGMENT_THRESHOLDS.vipOrders ||
    input.totalSpendMinor >= SEGMENT_THRESHOLDS.vipSpendMinor
  ) {
    return "vip";
  }
  if (input.orderCount >= SEGMENT_THRESHOLDS.regularOrders) return "regular";
  return "occasional";
}
