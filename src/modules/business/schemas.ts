import { z } from "zod";

/**
 * Phase 4 — Business + Outlet validation.
 *
 * Every field the owner manages passes through these schemas before any
 * database write. The database layer (check constraints + RPC) provides the
 * second line of defence; nothing here is trusted as-is from the client.
 */

// ── shared constants ────────────────────────────────────────────────────────

export const RESTAURANT_TYPES = [
  "quick_service",
  "casual_dining",
  "fine_dining",
  "cafe",
  "cloud_kitchen",
  "bakery",
  "bar_pub",
  "food_truck",
  "other",
] as const;

export const RESTAURANT_TYPE_LABELS: Record<(typeof RESTAURANT_TYPES)[number], string> = {
  quick_service: "Quick service",
  casual_dining: "Casual dining",
  fine_dining: "Fine dining",
  cafe: "Café",
  cloud_kitchen: "Cloud kitchen",
  bakery: "Bakery",
  bar_pub: "Bar / pub",
  food_truck: "Food truck",
  other: "Other",
};

export const ORDER_TYPES = ["dine_in", "takeaway", "delivery"] as const;

export const ORDER_TYPE_LABELS: Record<(typeof ORDER_TYPES)[number], string> = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  delivery: "Delivery",
};

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const WEEKDAY_LABELS: Record<(typeof WEEKDAYS)[number], string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** Common currencies a restaurant business may operate in. */
export const CURRENCIES = [
  "INR", "USD", "EUR", "GBP", "AED", "SAR", "SGD", "MYR",
  "AUD", "CAD", "NZD", "JPY", "CHF", "THB", "IDR", "PHP",
  "ZAR", "LKR", "NPR", "BDT", "QAR", "KWD", "OMR", "BHD",
] as const;

/** Timezones offered in the UI (IANA). */
function supportedTimezones(): string[] {
  try {
    const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
      "timeZone",
    );
    const zones = list && list.length > 0 ? [...list] : ["UTC"];
    // Older ICU builds list legacy aliases (e.g. Asia/Calcutta) — make sure
    // the modern canonical names people actually type are offered too.
    for (const alias of ["Asia/Kolkata", "Asia/Yangon", "Asia/Ho_Chi_Minh"]) {
      if (!zones.includes(alias)) zones.push(alias);
    }
    return zones.sort();
  } catch {
    return ["UTC", "Asia/Kolkata"];
  }
}
export const TIMEZONES: readonly string[] = supportedTimezones();

/** Accepts any IANA zone the runtime understands (both alias spellings). */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ── building blocks ─────────────────────────────────────────────────────────

const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`);

const optionalText = (max: number) =>
  trimmed(max)
    .optional()
    .or(z.literal(""))
    .transform((v) => (typeof v === "string" && v.trim() === "" ? null : (v as string | null | undefined) ?? null));

const phoneSchema = optionalText(20).refine(
  (v) => v === null || /^[+()\-\s\d]{6,20}$/.test(v),
  "Enter a valid phone number",
);

const emailSchema = optionalText(254).refine(
  (v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  "Enter a valid email address",
);

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM format");

const daySchedule = z
  .object({ open: timeOfDay, close: timeOfDay })
  .nullable();

/** {"mon":{"open":"09:00","close":"22:00"}, ..., "sun":null} */
export const operatingHoursSchema = z.partialRecord(z.enum(WEEKDAYS), daySchedule);

export type OperatingHours = z.infer<typeof operatingHoursSchema>;

/** Server-side slug generator shared by UI previews and actions. */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics: é → e
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug.length >= 2 ? slug : "restaurant";
}

// ── business ────────────────────────────────────────────────────────────────

export const businessIdSchema = z.uuid("Business id is invalid");

export const createBusinessSchema = z.object({
  name: trimmed(80).min(2, "Business name must be at least 2 characters"),
  restaurantType: z.enum(RESTAURANT_TYPES),
  currency: z.enum(CURRENCIES),
  timezone: z.string().refine((v) => isValidTimezone(v), "Unknown timezone"),
  email: emailSchema,
  phone: phoneSchema,
  addressLine1: optionalText(120),
  addressLine2: optionalText(120),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: optionalText(12),
  country: optionalText(80),
  taxNumber: optionalText(32).refine(
    (v) => v === null || /^[A-Za-z0-9-]{3,32}$/.test(v),
    "Tax numbers contain letters, digits and dashes only",
  ),
  logoUrl: optionalText(2048).refine(
    (v) => v === null || /^https?:\/\/.+/.test(v),
    "Logo must be an http(s) URL",
  ),
});

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

/** Edits reuse the same shape; identity fields (id/slug/status) are untouchable. */
export const updateBusinessSchema = createBusinessSchema;

// ── outlet ──────────────────────────────────────────────────────────────────

export const outletIdSchema = z.uuid("Outlet id is invalid");

const outletCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/, "Use 1–16 letters, digits, dashes or underscores"),
  );

const orderTypesSchema = z
  .array(z.enum(ORDER_TYPES))
  .min(1, "Select at least one order type")
  .transform((types) => [...new Set(types)]);

export const createOutletSchema = z.object({
  businessId: businessIdSchema,
  name: trimmed(80).min(2, "Outlet name must be at least 2 characters"),
  code: outletCodeSchema,
  email: emailSchema,
  phone: phoneSchema,
  addressLine1: optionalText(120),
  addressLine2: optionalText(120),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: optionalText(12),
  country: optionalText(80),
  orderTypes: orderTypesSchema,
  operatingHours: operatingHoursSchema.default({}),
});

export type CreateOutletInput = z.infer<typeof createOutletSchema>;

export const updateOutletSchema = createOutletSchema.omit({ businessId: true }).extend({
  outletId: outletIdSchema,
});

export type UpdateOutletInput = z.infer<typeof updateOutletSchema>;

export const setOutletStatusSchema = z.object({
  outletId: outletIdSchema,
  active: z.preprocess((v) => v === true || v === "true", z.boolean()),
});
