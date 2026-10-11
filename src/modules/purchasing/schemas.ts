import { z } from "zod";
import { hasAtMostTwoDecimals } from "@/modules/purchasing/money";

/**
 * Phase 14 — input schemas for purchasing forms. The server actions parse every
 * field again; the RPCs re-check permissions, quantities, prices and balances.
 * Lines arrive as a JSON string from a hidden field and are parsed here.
 */

const uuid = z.string().uuid("Choose a valid option.");
const optionalUuid = z
  .string()
  .uuid()
  .optional()
  .or(z.literal("").transform(() => undefined));
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters.`)
    .optional()
    .or(z.literal("").transform(() => undefined));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date.");
const optionalIsoDate = isoDate.optional().or(z.literal("").transform(() => undefined));
const clientRef = z.string().trim().min(8).max(80);
const qty = z.coerce
  .number({ error: "Enter a quantity." })
  .positive("Quantity must be more than zero.")
  .max(1e9, "Quantity is too large.");
const rupees = z.coerce
  .number({ error: "Enter an amount." })
  .min(0, "Cannot be negative.")
  .max(1e7, "Amount is too large.")
  .refine(hasAtMostTwoDecimals, "Use at most two decimal places.");
const positiveRupees = rupees.refine((v) => v > 0, "Enter an amount above zero.");

export const supplierSchema = z.object({
  businessId: uuid,
  id: optionalUuid,
  name: z.string().trim().min(1, "Name is required.").max(120, "Keep the name under 120 characters."),
  contactName: optionalText(80),
  phone: optionalText(20),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .or(z.literal("").transform(() => undefined))
    .refine((v) => v === undefined || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Enter a valid email."),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .optional()
    .or(z.literal("").transform(() => undefined))
    .refine((v) => v === undefined || /^[0-9A-Z]{15}$/.test(v), "GSTIN must be 15 letters or digits."),
  address: optionalText(300),
  paymentTermsDays: z.coerce
    .number({ error: "Enter the payment terms in days." })
    .int("Use whole days.")
    .min(0, "Cannot be negative.")
    .max(365, "Use 365 days or fewer."),
  status: z.enum(["active", "inactive"]),
  notes: optionalText(500),
});

const poLineSchema = z.object({
  ingredientId: uuid,
  unit: z.string().min(1).max(4),
  qty,
  unitCostRupees: rupees,
});

export const purchaseOrderLinesSchema = z
  .array(poLineSchema)
  .min(1, "Add at least one line.")
  .max(60, "At most 60 lines per order.");

export const purchaseOrderSchema = z.object({
  businessId: uuid,
  outletId: uuid,
  supplierId: uuid,
  id: optionalUuid,
  expectedOn: optionalIsoDate,
  notes: optionalText(500),
  lines: purchaseOrderLinesSchema,
});

const grnLineSchema = z.object({
  poItemId: uuid,
  qty,
  unit: z.string().min(1).max(4),
  batchCode: optionalText(40),
  expiresOn: optionalIsoDate,
});

export const goodsReceiptSchema = z.object({
  businessId: uuid,
  outletId: uuid,
  purchaseOrderId: uuid,
  clientRef,
  deliveryNote: optionalText(120),
  notes: optionalText(500),
  lines: z.array(grnLineSchema).min(1, "Enter the quantity received for at least one line."),
});

const invoiceLineSchema = z.object({
  goodsReceiptItemId: uuid,
  unitCostRupees: rupees,
});

export const supplierInvoiceSchema = z
  .object({
    businessId: uuid,
    outletId: uuid,
    supplierId: uuid,
    invoiceNumber: z.string().trim().min(1, "Enter the supplier's invoice number.").max(40),
    invoiceDate: isoDate,
    dueOn: isoDate,
    taxRupees: rupees,
    notes: optionalText(300),
    clientRef,
    lines: z.array(invoiceLineSchema).min(1, "Choose at least one received line to bill."),
  })
  .refine((v) => v.dueOn >= v.invoiceDate, {
    message: "The due date cannot be before the invoice date.",
    path: ["dueOn"],
  });

export const supplierPaymentSchema = z.object({
  businessId: uuid,
  supplierId: uuid,
  amountRupees: positiveRupees,
  method: z.enum(["cash", "bank_transfer", "upi", "cheque", "card", "other"], {
    error: "Choose a payment method.",
  }),
  paidOn: optionalIsoDate,
  reference: optionalText(80),
  clientRef,
});

export const purchaseOrderActionSchema = z.object({
  businessId: uuid,
  outletId: uuid,
  purchaseOrderId: uuid,
});

export const purchaseOrderCancelSchema = purchaseOrderActionSchema.extend({
  reason: z.string().trim().min(3, "Give a reason (at least 3 characters).").max(200),
});
