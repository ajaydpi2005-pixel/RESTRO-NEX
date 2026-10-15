/**
 * Phase 17 — online and QR ordering constants. Pure data; safe for client and server.
 *
 * Limits here mirror the database checks (pos_persist_items, orders_channel_shape,
 * outlet_ordering_settings). The UI uses them for hints only. The server and the
 * database enforce them again.
 */

export const ITEM_LIMIT = 100;
export const QUANTITY_LIMIT = 99;
export const MODIFIER_LIMIT = 20;
export const MODIFIER_QUANTITY_LIMIT = 20;
export const NOTES_LIMIT = 200;
export const ORDER_NOTES_LIMIT = 400;
export const PHONE_LIMIT = 20;
export const NAME_LIMIT = 80;
export const ADDRESS_LIMIT = 300;
export const PREP_MINUTES_MIN = 5;
export const PREP_MINUTES_MAX = 240;

/** Public requests larger than this are refused before parsing. */
export const PUBLIC_BODY_LIMIT_BYTES = 32 * 1024;

export const CHANNEL_LABELS: Record<"pos" | "online" | "qr", string> = {
  pos: "Counter / POS",
  online: "Website",
  qr: "QR table",
};

export const PAYMENT_MODE_LABELS: Record<string, string> = {
  pay_at_counter: "Pay at counter",
  pay_on_delivery: "Pay on delivery",
  pay_at_table: "Pay at table",
};

export const INTAKE_LABELS: Record<string, string> = {
  awaiting_acceptance: "Awaiting acceptance",
  accepted: "Accepted",
  rejected: "Rejected",
};

/**
 * Shown on every public order screen. No online payment is taken in Phase 17:
 * payments are recorded by staff, and a gateway can only mark an order paid
 * after a verified provider webhook (external integration phase).
 */
export const NO_ONLINE_PAYMENT_NOTE =
  "No payment is taken online yet. You pay the restaurant at the counter, on delivery, or at your table, as shown.";

export const FINAL_TOTAL_NOTE =
  "The total shown here is an estimate. The restaurant confirms the final amount, including tax and fees, when it accepts your order.";
