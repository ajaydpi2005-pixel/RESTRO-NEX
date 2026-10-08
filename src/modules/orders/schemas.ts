import { z } from "zod";

/**
 * Phase 8 — POS payload validation.
 *
 * The client sends ids, quantities, notes, discount and charges — NEVER
 * prices. The DB RPCs re-resolve every price from the menu tables, so these
 * schemas are the first of two server-side gates.
 */

export const POS_CHARGE_LIMIT = 5;
export const POS_ITEM_LIMIT = 100;

const trimmed = (max: number) => z.string().trim().max(max, `Must be ${max} characters or fewer`);

const optionalText = (max: number) =>
  trimmed(max)
    .optional()
    .or(z.literal(""))
    .transform((v) =>
      typeof v === "string" && v.trim() === "" ? null : ((v as string | null | undefined) ?? null),
    );

export const posModifierSchema = z.object({
  modifierId: z.uuid("Option id is invalid"),
  quantity: z.number().int().min(1).max(20, "Option quantity must be 1–20"),
});

export const posItemSchema = z
  .object({
    itemType: z.enum(["product", "combo"]),
    productId: z.uuid().nullish(),
    comboId: z.uuid().nullish(),
    variantId: z.uuid().nullish(),
    quantity: z.number().int().min(1, "Quantity must be at least 1").max(99, "Quantity must be 99 or fewer"),
    itemNotes: optionalText(200),
    modifiers: z.array(posModifierSchema).max(20, "At most 20 options per item").default([]),
  })
  .refine((item) => (item.itemType === "product" ? Boolean(item.productId) : Boolean(item.comboId)), {
    message: "Item is missing its product or combo",
    path: ["itemType"],
  })
  .refine((item) => !(item.itemType === "combo" && item.variantId), {
    message: "Combos do not take variants",
    path: ["variantId"],
  });

export const posDiscountSchema = z
  .object({
    type: z.enum(["none", "percent", "flat"]),
    value: z.number().min(0, "Discount cannot be negative"),
  })
  .refine((d) => d.type !== "percent" || d.value <= 100, {
    message: "Percentage discounts cannot exceed 100%",
    path: ["value"],
  })
  .refine((d) => d.type !== "flat" || d.value <= 100000000, {
    message: "Discount amount is out of range",
    path: ["value"],
  });

export const posChargeSchema = z.object({
  name: trimmed(40).min(1, "Charge name is required"),
  amountMinor: z.number().int().min(0).max(10000000, "Charge amount is out of range"),
});

export const posOrderPayloadSchema = z
  .object({
    outletId: z.uuid("Outlet id is invalid"),
    clientRef: z.string().trim().min(8, "Order reference is invalid").max(64),
    orderId: z.uuid().nullish(),
    status: z.enum(["open", "held"]).default("open"),
    orderType: z.enum(["dine_in", "takeaway", "delivery"]),
    tableId: z.uuid().nullish(),
    customerName: optionalText(80),
    customerPhone: optionalText(20).refine(
      (v) => v === null || /^[+()\-.\s\d]{6,20}$/.test(v),
      "Enter a valid phone number",
    ),
    deliveryAddress: optionalText(300),
    notes: optionalText(400),
    discount: posDiscountSchema.default({ type: "none", value: 0 }),
    charges: z.array(posChargeSchema).max(POS_CHARGE_LIMIT, `At most ${POS_CHARGE_LIMIT} charges`).default([]),
    items: z.array(posItemSchema).min(1, "The order has no items").max(POS_ITEM_LIMIT),
  })
  .refine((p) => p.orderType !== "dine_in" || Boolean(p.tableId), {
    message: "Dine-in orders need a table",
    path: ["tableId"],
  })
  .refine(
    (p) => p.orderType !== "delivery" || (Boolean(p.customerPhone) && Boolean(p.deliveryAddress)),
    { message: "Delivery orders need a phone number and address", path: ["customerPhone"] },
  );

export type PosOrderPayload = z.infer<typeof posOrderPayloadSchema>;
