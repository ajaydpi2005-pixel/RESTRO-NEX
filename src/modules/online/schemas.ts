import { z } from "zod";
import {
  ADDRESS_LIMIT,
  MODIFIER_LIMIT,
  MODIFIER_QUANTITY_LIMIT,
  NAME_LIMIT,
  NOTES_LIMIT,
  ORDER_NOTES_LIMIT,
  PHONE_LIMIT,
  PREP_MINUTES_MAX,
  PREP_MINUTES_MIN,
  QUANTITY_LIMIT,
  ITEM_LIMIT,
} from "./constants";

/**
 * Phase 17 — input validation.
 *
 * Public checkout sends ids, quantities and options only. It never sends a price,
 * a discount, a charge, a tax amount, a status, a business id or an outlet id
 * that the server trusts. The DB re-prices every line, and these schemas strip
 * any other key before anything reaches the database.
 */

const trimmedOptional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .optional()
    .nullable()
    .transform((value) => (value && value.trim() !== "" ? value.trim() : null));

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const slugSchema = z.string().trim().min(1).max(60).regex(SLUG, "Invalid link");

/** Client-chosen idempotency key. Random, 16–40 url-safe characters. */
export const clientRefSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{16,40}$/,
    "The order reference is invalid. Refresh the page and try again.",
  );

/** Customer-held tracking secret (random, url-safe). Only its hash is stored. */
export const trackingSecretSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,96}$/, "The tracking secret is invalid.");

/** Printed QR token (random, url-safe). Only its hash is stored. */
export const qrTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{20,80}$/, "This QR link is not valid.");

export const orderIdSchema = z.uuid("Order id is invalid");

export const publicItemSchema = z.object({
  kind: z.enum(["product", "combo"]),
  id: z.uuid("Item id is invalid"),
  variantId: z.uuid().nullish(),
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .max(QUANTITY_LIMIT, `Quantity must be ${QUANTITY_LIMIT} or fewer`),
  notes: trimmedOptional(NOTES_LIMIT),
  modifiers: z
    .array(
      z.object({
        id: z.uuid("Option id is invalid"),
        quantity: z.number().int().min(1).max(MODIFIER_QUANTITY_LIMIT),
      }),
    )
    .max(MODIFIER_LIMIT, `At most ${MODIFIER_LIMIT} options per item`)
    .default([]),
});

export type PublicItemInput = z.infer<typeof publicItemSchema>;

export const checkoutSchema = z
  .object({
    channel: z.enum(["online", "qr"]),
    businessSlug: slugSchema.optional(),
    outletSlug: slugSchema.optional(),
    qrToken: qrTokenSchema.optional(),
    clientRef: clientRefSchema,
    trackingSecret: trackingSecretSchema,
    orderType: z.enum(["takeaway", "delivery"]).optional(),
    customerName: trimmedOptional(NAME_LIMIT),
    customerPhone: trimmedOptional(PHONE_LIMIT),
    deliveryAddress: trimmedOptional(ADDRESS_LIMIT),
    notes: trimmedOptional(ORDER_NOTES_LIMIT),
    items: z
      .array(publicItemSchema)
      .min(1, "Add at least one item")
      .max(ITEM_LIMIT, `An order can have at most ${ITEM_LIMIT} items`),
  })
  .superRefine((value, ctx) => {
    if (value.channel === "online") {
      if (!value.businessSlug || !value.outletSlug) {
        ctx.addIssue({
          code: "custom",
          path: ["outletSlug"],
          message: "Choose a restaurant to order from",
        });
      }
      if (!value.orderType) {
        ctx.addIssue({
          code: "custom",
          path: ["orderType"],
          message: "Choose takeaway or delivery",
        });
      }
      if (!value.customerPhone) {
        ctx.addIssue({ code: "custom", path: ["customerPhone"], message: "Enter a phone number" });
      }
      if (value.orderType === "delivery" && !value.deliveryAddress) {
        ctx.addIssue({
          code: "custom",
          path: ["deliveryAddress"],
          message: "Enter a delivery address",
        });
      }
    } else if (!value.qrToken) {
      ctx.addIssue({ code: "custom", path: ["qrToken"], message: "This QR link is not valid." });
    }
  });

export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ── Staff ───────────────────────────────────────────────────────────────────

export const outletScopeSchema = z.object({
  businessId: z.uuid("Business id is invalid"),
  outletId: z.uuid("Outlet id is invalid"),
});

export const intakeActionSchema = outletScopeSchema.extend({
  orderId: orderIdSchema,
});

export const rejectActionSchema = intakeActionSchema.extend({
  reason: z
    .string()
    .trim()
    .min(3, "Give a short reason for the customer")
    .max(200, "Keep the reason to 200 characters"),
});

export const settingsActionSchema = outletScopeSchema.extend({
  onlineEnabled: z.boolean(),
  takeawayEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
  qrEnabled: z.boolean(),
  acceptingOrders: z.boolean(),
  autoAccept: z.boolean(),
  minOrderMinor: z.number().int().min(0).max(100_000_000),
  deliveryFeeMinor: z.number().int().min(0).max(1_000_000),
  packagingFeeMinor: z.number().int().min(0).max(1_000_000),
  prepMinutes: z
    .number()
    .int()
    .min(
      PREP_MINUTES_MIN,
      `Preparation time must be ${PREP_MINUTES_MIN}–${PREP_MINUTES_MAX} minutes`,
    )
    .max(
      PREP_MINUTES_MAX,
      `Preparation time must be ${PREP_MINUTES_MIN}–${PREP_MINUTES_MAX} minutes`,
    ),
});

export const qrIssueSchema = outletScopeSchema.extend({
  tableId: z.uuid("Choose a table"),
  label: z
    .string()
    .trim()
    .min(1, "Give the QR code a label")
    .max(60, "Keep the label to 60 characters"),
});

export const qrRevokeSchema = outletScopeSchema.extend({
  qrId: z.uuid("QR code id is invalid"),
});
