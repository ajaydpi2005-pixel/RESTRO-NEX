import { z } from "zod";
import { parseMoneyToMinor } from "@/lib/money";

/**
 * Phase 10 — input contracts for money actions. Clients send display strings
 * ("120.50"); the server converts them to integer minor units with
 * `parseMoneyToMinor` before anything reaches the database.
 */

export const METHOD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
export const CLIENT_REF_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const PAYMENT_METHOD_KINDS = ["cash", "upi", "card", "other"] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

const uuid = z.uuid("Invalid identifier.");
const trimmed = (max: number, message: string) => z.string().trim().max(max, message);

const moneyField = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine((v) => parseMoneyToMinor(v) !== null, `${label}: enter an exact amount with at most two decimals.`);

export const paymentLineSchema = z.object({
  methodKey: z.string().trim().regex(METHOD_KEY_PATTERN, "Choose a payment method."),
  amount: moneyField("Amount"),
  tendered: z.string().trim().max(20).optional().default(""),
  reference: trimmed(120, "References must be 120 characters or fewer.").optional().default(""),
});
export type PaymentLineInput = z.infer<typeof paymentLineSchema>;

const linesJson = z
  .string()
  .min(2, "Enter at least one payment.")
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "The payment could not be read. Refresh and retry." });
      return z.NEVER;
    }
  })
  .pipe(z.array(paymentLineSchema).min(1, "Enter at least one payment.").max(6, "A bill takes at most 6 payment lines."));

export const recordPaymentsSchema = z.object({
  businessId: uuid,
  orderId: uuid,
  batchKey: z.string().regex(CLIENT_REF_PATTERN, "Payment reference is invalid. Refresh and retry."),
  lines: linesJson,
});

export const refundSchema = z.object({
  businessId: uuid,
  paymentId: uuid,
  amount: moneyField("Refund amount"),
  reason: trimmed(200, "Reason must be 200 characters or fewer.").pipe(
    z.string().min(3, "Give a reason for the refund (at least 3 characters)."),
  ),
  refundKey: z.string().regex(CLIENT_REF_PATTERN, "Refund reference is invalid. Refresh and retry."),
});

export const issueInvoiceSchema = z.object({ businessId: uuid, orderId: uuid });

export const voidInvoiceSchema = z.object({
  businessId: uuid,
  invoiceId: uuid,
  reason: trimmed(200, "Reason must be 200 characters or fewer.").pipe(
    z.string().min(3, "Give a reason for voiding the invoice (at least 3 characters)."),
  ),
});

export const receiptPrintSchema = z.object({ businessId: uuid, receiptId: uuid });

export const paymentMethodSchema = z.object({
  businessId: uuid,
  methodId: z.string().trim().optional().default(""),
  key: z.string().trim().optional().default(""),
  label: trimmed(40, "Label must be 40 characters or fewer.").pipe(z.string().min(1, "Enter a label.")),
  kind: z.enum(PAYMENT_METHOD_KINDS, { message: "Choose a method type." }),
  requiresReference: z.enum(["true", "false"]).transform((v) => v === "true"),
  isActive: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export const reconciliationSchema = z.object({
  businessId: uuid,
  outletId: uuid,
  from: z.iso.date("Choose a start date."),
  to: z.iso.date("Choose an end date."),
});

/** IST (UTC+05:30, no DST) day boundaries as timestamptz strings. */
export function istDayStart(isoDate: string): string {
  return `${isoDate}T00:00:00+05:30`;
}

/** Exclusive end: the start of the following IST day. */
export function istDayEndExclusive(isoDate: string): string {
  const next = new Date(`${isoDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T00:00:00+05:30`;
}
