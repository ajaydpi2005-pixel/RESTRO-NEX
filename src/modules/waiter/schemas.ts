import { z } from "zod";
import { POS_ITEM_LIMIT, posItemSchema } from "@/modules/orders/schemas";
import { WAITER_ORDER_NOTE_MAX } from "@/modules/waiter/cart";

/**
 * Phase 12 — waiter submission payload.
 *
 * Deliberately narrower than the POS payload: no discount, no charges, no
 * takeaway or delivery, and no prices. `.strict()` rejects any extra key, so a
 * tampered client that adds `discount` or `charges` is refused before the RPC.
 */
export const waiterSubmitSchema = z
  .object({
    outletId: z.uuid("Outlet id is invalid"),
    clientRef: z.string().trim().min(8, "Order reference is invalid").max(64),
    tableId: z.uuid().nullish(),
    orderId: z.uuid().nullish(),
    notes: z
      .string()
      .trim()
      .max(WAITER_ORDER_NOTE_MAX, `Order note must be ${WAITER_ORDER_NOTE_MAX} characters or fewer`)
      .nullish()
      .transform((v) => (v && v.length > 0 ? v : null)),
    send: z.boolean(),
    items: z
      .array(posItemSchema)
      .min(1, "Add at least one item")
      .max(POS_ITEM_LIMIT, `At most ${POS_ITEM_LIMIT} items per round`),
  })
  .strict()
  .refine((p) => Boolean(p.orderId) || Boolean(p.tableId), {
    message: "Pick a table first",
    path: ["tableId"],
  });

export type WaiterSubmitInput = z.infer<typeof waiterSubmitSchema>;

/** snake_case payload for the waiter_submit_order RPC. */
export function toDbSubmitPayload(input: WaiterSubmitInput) {
  return {
    outlet_id: input.outletId,
    client_ref: input.clientRef,
    order_id: input.orderId ?? null,
    table_id: input.tableId ?? null,
    order_type: "dine_in",
    notes: input.notes,
    items: input.items.map((item) => ({
      item_type: item.itemType,
      product_id: item.productId ?? null,
      combo_id: item.comboId ?? null,
      variant_id: item.variantId ?? null,
      quantity: item.quantity,
      item_notes: item.itemNotes ?? null,
      modifiers: item.modifiers.map((m) => ({ modifier_id: m.modifierId, quantity: m.quantity })),
    })),
  };
}
