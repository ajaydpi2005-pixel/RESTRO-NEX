import { z } from "zod";
import { hasAtMostTwoDecimals, rupeesToPaise } from "@/modules/purchasing/money";
import { PHONE_PATTERN } from "@/modules/customers/phone";

/**
 * Phase 15 — input schemas for customer, loyalty and promotion forms. Every
 * field arrives as a string from FormData. The server actions parse it here and
 * the RPCs check it again, so a bad value cannot reach the database.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_PATTERN, "Choose a valid option.");
const optionalUuid = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined))
  .pipe(z.union([z.undefined(), uuid]));
const text = (max: number, message: string) => z.string().trim().min(1, message).max(max, message);
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((value) => (value ? value : undefined));

/** Whole-number count from a text field. */
const wholeNumber = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+$/, message)
    .transform(Number)
    .refine((value) => value >= min && value <= max, message);

/** Rupees with at most two decimals, converted to paise. */
const rupees = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, message)
    .transform(Number)
    .refine((value) => hasAtMostTwoDecimals(value) && value >= min && value <= max, message)
    .transform((value) => rupeesToPaise(value));

const optionalRupees = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .pipe(z.union([z.undefined(), rupees(min, max, message)]));

const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined))
  .pipe(z.union([z.undefined(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")]));

const optionalWhole = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .pipe(z.union([z.undefined(), wholeNumber(min, max, message)]));

const checkbox = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "true");

export const customerSchema = z.object({
  businessId: uuid,
  id: optionalUuid,
  name: text(80, "Enter the customer name (up to 80 characters)."),
  phone: z
    .string()
    .trim()
    .regex(PHONE_PATTERN, "Enter a phone number with 7 or more digits.")
    .refine(
      (value) => value.replace(/\D/g, "").length >= 7,
      "Enter a phone number with 7 or more digits.",
    ),
  email: optionalText(254, "Enter a valid email address.").pipe(
    z.union([z.undefined(), z.string().email("Enter a valid email address.")]),
  ),
  notes: optionalText(500, "Notes can be up to 500 characters."),
});

export const addressSchema = z.object({
  businessId: uuid,
  customerId: uuid,
  id: optionalUuid,
  label: text(30, "Label must be 1 to 30 characters."),
  address: text(300, "Address must be 1 to 300 characters."),
});

export const deleteAddressSchema = z.object({
  businessId: uuid,
  id: uuid,
});

export const loyaltySettingsSchema = z.object({
  businessId: uuid,
  enabled: checkbox,
  earnRupeesPerPoint: rupees(
    1,
    100000,
    "A point must be worth between ₹1 and ₹1,00,000 of net spend.",
  ),
});

export const rewardSchema = z
  .object({
    businessId: uuid,
    id: optionalUuid,
    name: text(80, "Reward name must be 1 to 80 characters."),
    pointsCost: wholeNumber(1, 1_000_000, "Points cost must be between 1 and 1,000,000."),
    discountType: z.enum(["flat", "percent"], { message: "Choose flat or percent." }),
    discountValue: z.string().trim().min(1, "Enter the discount."),
    maxDiscount: optionalRupees(
      1,
      100000,
      "The maximum discount must be between ₹1 and ₹1,00,000.",
    ),
    active: checkbox,
  })
  .superRefine((value, ctx) => {
    if (value.discountType === "percent") {
      const percent = Number(value.discountValue);
      if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
        ctx.addIssue({
          code: "custom",
          path: ["discountValue"],
          message: "Percent must be a whole number from 1 to 100.",
        });
      }
    } else {
      const amount = Number(value.discountValue);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
        ctx.addIssue({
          code: "custom",
          path: ["discountValue"],
          message: "Flat amount must be between ₹1 and ₹1,00,000.",
        });
      }
    }
  })
  .transform((value) => ({
    ...value,
    discountValueMinor:
      value.discountType === "percent"
        ? Number(value.discountValue)
        : rupeesToPaise(Number(value.discountValue)),
  }));

export const couponSchema = z
  .object({
    businessId: uuid,
    id: optionalUuid,
    code: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(
        z
          .string()
          .regex(/^[A-Z0-9-]{3,20}$/, "A coupon code is 3 to 20 letters, digits or dashes."),
      ),
    name: text(80, "Coupon name must be 1 to 80 characters."),
    discountType: z.enum(["flat", "percent"], { message: "Choose flat or percent." }),
    discountValue: z.string().trim().min(1, "Enter the discount."),
    maxDiscount: optionalRupees(
      1,
      100000,
      "The maximum discount must be between ₹1 and ₹1,00,000.",
    ),
    minSubtotal: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value ? value : "0"))
      .pipe(rupees(0, 10000000, "The minimum order must be between ₹0 and ₹1,00,000 a bill.")),
    startsOn: optionalDate,
    endsOn: optionalDate,
    usageLimit: optionalWhole(1, 1_000_000, "The usage limit must be a whole number above zero."),
    perCustomerLimit: optionalWhole(
      1,
      1000,
      "The per-customer limit must be a whole number above zero.",
    ),
    active: checkbox,
  })
  .superRefine((value, ctx) => {
    if (value.discountType === "percent") {
      const percent = Number(value.discountValue);
      if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
        ctx.addIssue({
          code: "custom",
          path: ["discountValue"],
          message: "Percent must be a whole number from 1 to 100.",
        });
      }
    } else {
      const amount = Number(value.discountValue);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
        ctx.addIssue({
          code: "custom",
          path: ["discountValue"],
          message: "Flat amount must be between ₹1 and ₹1,00,000.",
        });
      }
    }
    if (value.startsOn && value.endsOn && value.endsOn < value.startsOn) {
      ctx.addIssue({
        code: "custom",
        path: ["endsOn"],
        message: "The end date is before the start date.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    discountValueMinor:
      value.discountType === "percent"
        ? Number(value.discountValue)
        : rupeesToPaise(Number(value.discountValue)),
  }));

export const pointsAdjustSchema = z.object({
  businessId: uuid,
  customerId: uuid,
  points: wholeNumber(
    -1_000_000,
    1_000_000,
    "Enter a non-zero number of points between -1,000,000 and 1,000,000.",
  ).refine((value) => value !== 0, "Enter a non-zero number of points."),
  reason: text(200, "Give a reason of 3 to 200 characters.").refine(
    (value) => value.length >= 3,
    "Give a reason of 3 to 200 characters.",
  ),
  clientRef: text(80, "A client reference is required."),
});

export const redeemRewardSchema = z.object({
  businessId: uuid,
  customerId: uuid,
  rewardId: uuid,
  clientRef: text(80, "A client reference is required."),
});

export const applyPromotionSchema = z.object({
  businessId: uuid,
  orderId: uuid,
  code: optionalText(20, "That coupon code does not exist.").pipe(
    z.union([z.undefined(), z.string()]),
  ),
  voucherId: optionalUuid,
});

export const removePromotionSchema = z.object({
  businessId: uuid,
  orderId: uuid,
});
