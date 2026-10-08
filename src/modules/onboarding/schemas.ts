import { z } from "zod";
import {
  CURRENCIES,
  ORDER_TYPES,
  RESTAURANT_TYPES,
  isValidTimezone,
} from "@/modules/business/schemas";

/**
 * Phase 6 — Onboarding validation.
 *
 * Wizard forms arrive as flat FormData (parallel arrays for repeatable rows),
 * are normalised here, and only then touch the database. The DB adds the
 * second line of defence (check constraints + RPC validation).
 */

const trimmed = (max: number) => z.string().trim().max(max, `Must be ${max} characters or fewer`);

const optionalText = (max: number) =>
  trimmed(max)
    .optional()
    .or(z.literal(""))
    .transform((v) =>
      typeof v === "string" && v.trim() === "" ? null : ((v as string | null | undefined) ?? null),
    );

const phoneSchema = optionalText(20).refine(
  (v) => v === null || /^[+()\-.\s\d]{6,20}$/.test(v),
  "Enter a valid phone number",
);

const emailSchema = optionalText(254).refine(
  (v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  "Enter a valid email address",
);

// ── step: create business ───────────────────────────────────────────────────

export const onboardingBusinessSchema = z.object({
  name: trimmed(80).min(2, "Business name must be at least 2 characters"),
  currency: z.enum(CURRENCIES),
  timezone: z.string().refine((v) => isValidTimezone(v), "Unknown timezone"),
});

export type OnboardingBusinessInput = z.infer<typeof onboardingBusinessSchema>;

// ── step: restaurant type ───────────────────────────────────────────────────

export const restaurantTypeSchema = z.object({
  restaurantType: z.enum(RESTAURANT_TYPES),
});

// ── step: first outlet ──────────────────────────────────────────────────────

export const onboardingOutletSchema = z.object({
  name: trimmed(80).min(2, "Outlet name must be at least 2 characters"),
  email: emailSchema,
  phone: phoneSchema,
  addressLine1: optionalText(120),
  addressLine2: optionalText(120),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: optionalText(12),
  country: optionalText(80),
  orderTypes: z
    .array(z.enum(ORDER_TYPES))
    .min(1, "Select at least one order type")
    .transform((types) => [...new Set(types)]),
});

export type OnboardingOutletInput = z.infer<typeof onboardingOutletSchema>;

// ── step: business settings ─────────────────────────────────────────────────

export const onboardingSettingsSchema = z.object({
  name: trimmed(80).min(2, "Business name must be at least 2 characters"),
  email: emailSchema,
  phone: phoneSchema,
  addressLine1: optionalText(120),
  addressLine2: optionalText(120),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: optionalText(12),
  country: optionalText(80),
  currency: z.enum(CURRENCIES),
  timezone: z.string().refine((v) => isValidTimezone(v), "Unknown timezone"),
});

export type OnboardingSettingsInput = z.infer<typeof onboardingSettingsSchema>;

// ── step: tax settings ──────────────────────────────────────────────────────

const taxRatePct = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "Enter a rate like 5, 18 or 18.5")
  .transform((v) => Number(v))
  .refine((v) => v >= 0 && v <= 100, "Rate must be between 0 and 100");

export const taxSettingsSchema = z
  .object({
    taxEnabled: z.string(),
    taxNumber: optionalText(32).refine(
      (v) => v === null || /^[A-Za-z0-9-]{3,32}$/.test(v),
      "Tax numbers contain letters, digits and dashes only",
    ),
    invoiceFooter: optionalText(200),
    rateName: z.array(trimmed(40)),
    ratePct: z.array(z.string()),
    rateInclusive: z.array(z.enum(["inclusive", "exclusive"])),
  })
  .transform((raw, ctx) => {
    const rates: { name: string; pct: number; inclusive: boolean }[] = [];
    for (let i = 0; i < raw.rateName.length; i += 1) {
      const name = raw.rateName[i]?.trim() ?? "";
      const pctRaw = raw.ratePct[i] ?? "";
      const inclusiveRaw = raw.rateInclusive[i];
      if (name === "" && pctRaw.trim() === "") continue; // skip empty rows
      const parsed = taxRatePct.safeParse(pctRaw);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: `Rate ${i + 1}: enter a percentage like 5 or 18.5`, path: ["ratePct"] });
        continue;
      }
      rates.push({
        name: name === "" ? "Tax" : name,
        pct: parsed.data,
        inclusive: inclusiveRaw === "inclusive",
      });
    }
    if (rates.length > 5) {
      ctx.addIssue({ code: "custom", message: "At most 5 tax rates", path: ["rateName"] });
    }
    return {
      enabled: raw.taxEnabled === "yes",
      taxNumber: raw.taxNumber,
      invoiceFooter: raw.invoiceFooter,
      rates,
    };
  });

/** Shape persisted to businesses.tax_settings. */
export interface TaxSettingsDocument {
  enabled: boolean;
  rates: { name: string; pct: number; inclusive: boolean }[];
  invoice_footer: string | null;
}

// ── step: tables ────────────────────────────────────────────────────────────

const positiveInt = z
  .string()
  .trim()
  .regex(/^\d+$/, "Enter a whole number")
  .transform((v) => Number(v));

export const floorPlanSchema = z
  .object({
    sectionName: z.array(trimmed(60)),
    tableCount: z.array(z.string()),
    capacity: z.array(z.string()),
  })
  .transform((raw, ctx) => {
    const sections: { name: string; tables: { label: string; capacity: number }[] }[] = [];
    let tableNumber = 0;
    let totalTables = 0;
    for (let i = 0; i < raw.sectionName.length; i += 1) {
      const name = raw.sectionName[i]?.trim() ?? "";
      if (name === "") continue;
      const countParsed = positiveInt.safeParse(raw.tableCount[i] ?? "");
      const capacityParsed = positiveInt.safeParse(raw.capacity[i] ?? "");
      if (!countParsed.success || countParsed.data < 1 || countParsed.data > 200) {
        ctx.addIssue({ code: "custom", message: `${name}: tables must be between 1 and 200`, path: ["tableCount"] });
        continue;
      }
      if (!capacityParsed.success || capacityParsed.data < 1 || capacityParsed.data > 50) {
        ctx.addIssue({ code: "custom", message: `${name}: seats per table must be between 1 and 50`, path: ["capacity"] });
        continue;
      }
      const tables: { label: string; capacity: number }[] = [];
      for (let n = 0; n < countParsed.data; n += 1) {
        tableNumber += 1;
        tables.push({ label: `T${tableNumber}`, capacity: capacityParsed.data });
      }
      totalTables += countParsed.data;
      sections.push({ name, tables });
    }
    if (sections.length === 0) {
      ctx.addIssue({ code: "custom", message: "Add at least one section with tables", path: ["sectionName"] });
    }
    if (totalTables > 500) {
      ctx.addIssue({ code: "custom", message: "At most 500 tables per outlet", path: ["tableCount"] });
    }
    return { sections };
  });

// ── step: kitchen ───────────────────────────────────────────────────────────

export const kitchenStationsSchema = z
  .object({
    stationName: z.array(trimmed(60)),
    stationDescription: z.array(optionalText(200)),
  })
  .transform((raw, ctx) => {
    const stations: { name: string; description: string | null }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < raw.stationName.length; i += 1) {
      const name = raw.stationName[i]?.trim() ?? "";
      if (name === "") continue;
      const key = name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: `Duplicate station: ${name}`, path: ["stationName"] });
        continue;
      }
      seen.add(key);
      stations.push({ name, description: raw.stationDescription[i] ?? null });
    }
    if (stations.length === 0) {
      ctx.addIssue({ code: "custom", message: "Add at least one kitchen station", path: ["stationName"] });
    }
    if (stations.length > 20) {
      ctx.addIssue({ code: "custom", message: "At most 20 stations per outlet", path: ["stationName"] });
    }
    return { stations };
  });

// ── step: menu ──────────────────────────────────────────────────────────────

/** "120", "120.5", "120.50" → minor units. Rejects anything else. */
export function priceToMinorUnits(input: string): number | null {
  const value = input.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

export const menuSetupSchema = z
  .object({
    categoryName: z.array(trimmed(60)),
    itemName: z.array(trimmed(80)),
    itemPrice: z.array(z.string()),
    itemFood: z.array(z.enum(["veg", "non_veg"])),
    itemDescription: z.array(optionalText(400)),
  })
  .transform((raw, ctx) => {
    const categoryOrder: string[] = [];
    const byCategory = new Map<string, { name: string; items: { name: string; description: string | null; price_minor: number; is_vegetarian: boolean }[] }>();
    for (let i = 0; i < raw.itemName.length; i += 1) {
      const itemName = raw.itemName[i]?.trim() ?? "";
      const category = raw.categoryName[i]?.trim() ?? "";
      if (itemName === "" && category === "") continue;
      if (category === "") {
        ctx.addIssue({ code: "custom", message: `Item ${i + 1}: choose a category`, path: ["categoryName"] });
        continue;
      }
      if (itemName === "") {
        ctx.addIssue({ code: "custom", message: `Row ${i + 1}: item name is required`, path: ["itemName"] });
        continue;
      }
      const price = priceToMinorUnits(raw.itemPrice[i] ?? "");
      if (price === null) {
        ctx.addIssue({ code: "custom", message: `"${itemName}": enter a price like 120 or 120.50`, path: ["itemPrice"] });
        continue;
      }
      const key = category.toLowerCase();
      let bucket = byCategory.get(key);
      if (!bucket) {
        bucket = { name: category, items: [] };
        byCategory.set(key, bucket);
        categoryOrder.push(key);
      }
      bucket.items.push({
        name: itemName,
        description: raw.itemDescription[i] ?? null,
        price_minor: price,
        is_vegetarian: raw.itemFood[i] === "veg",
      });
    }
    const categories = categoryOrder.map((key) => byCategory.get(key)!);
    if (categories.length === 0) {
      ctx.addIssue({ code: "custom", message: "Add at least one menu item", path: ["itemName"] });
    }
    if (categories.length > 30) {
      ctx.addIssue({ code: "custom", message: "At most 30 categories", path: ["categoryName"] });
    }
    const totalItems = categories.reduce((sum, c) => sum + c.items.length, 0);
    if (totalItems > 1000) {
      ctx.addIssue({ code: "custom", message: "At most 1000 items", path: ["itemName"] });
    }
    return { categories };
  });

// ── step: staff invites ─────────────────────────────────────────────────────

export const INVITE_ROLES = [
  "business_admin",
  "outlet_manager",
  "cashier",
  "waiter",
  "kitchen_staff",
  "inventory_manager",
  "accountant",
] as const;

export type InviteRole = (typeof INVITE_ROLES)[number];

export const INVITE_EXPIRY_DAYS = [1, 7, 30] as const;

export const staffInviteSchema = z
  .object({
    email: emailSchema,
    role: z.enum(INVITE_ROLES),
    outletId: z.array(z.uuid("Outlet id is invalid")),
    expiryDays: z.enum(["1", "7", "30"]).transform((v) => Number(v) as 1 | 7 | 30),
  })
  .refine((value) => value.role === "business_admin" || value.outletId.length > 0, {
    message: "Pick at least one outlet for this role",
    path: ["outletId"],
  });

export type StaffInviteInput = z.infer<typeof staffInviteSchema>;
