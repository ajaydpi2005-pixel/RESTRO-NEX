import { z } from "zod";

/**
 * Phase 7 — Universal menu validation.
 *
 * Every field passes through these schemas before a database write. Forms
 * arrive as flat FormData (parallel arrays for repeatable rows); transforms
 * normalise them into the shapes the actions persist.
 */

const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;

/** "120", "120.5", "120.50" → minor units (exact integer arithmetic). */
export function priceToMinorUnits(input: string): number | null {
  const value = input.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

/** Minor units → display string ("12050" → "120.50" without trailing .00). */
export function minorToDisplay(minor: number): string {
  return (minor / 100).toFixed(2).replace(/\.00$/, "");
}

const trimmed = (max: number) => z.string().trim().max(max, `Must be ${max} characters or fewer`);

const optionalText = (max: number) =>
  trimmed(max)
    .optional()
    .or(z.literal(""))
    .transform((v) =>
      typeof v === "string" && v.trim() === "" ? null : ((v as string | null | undefined) ?? null),
    );

const skuSchema = optionalText(32).refine(
  (v) => v === null || SKU_PATTERN.test(v),
  "SKUs: 2–32 letters, digits, dots, dashes or underscores",
);

const priceString = z.string().transform((v, ctx) => {
  const minor = priceToMinorUnits(v);
  if (minor === null) {
    ctx.addIssue({ code: "custom", message: "Enter a price like 120 or 120.50" });
    return 0;
  }
  return minor;
});

const taxRateString = optionalText(8).transform((v, ctx) => {
  if (v === null) return null;
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(v.trim())) {
    ctx.addIssue({ code: "custom", message: "Tax rate must be a percentage (0–100)" });
    return null;
  }
  const n = Number(v.trim());
  if (n < 0 || n > 100) {
    ctx.addIssue({ code: "custom", message: "Tax rate must be between 0 and 100" });
    return null;
  }
  return n;
});

const booleanSelect = z.enum(["yes", "no"]).default("yes").transform((v) => v === "yes");

// ── categories ──────────────────────────────────────────────────────────────

export const categoryIdSchema = z.uuid("Category id is invalid");

export const categorySchema = z.object({
  name: trimmed(60).min(1, "Category name is required"),
  parentId: z.uuid().nullish().or(z.literal("")).transform((v) => (v ? v : null)),
});

export const renameCategorySchema = z.object({
  categoryId: categoryIdSchema,
  name: trimmed(60).min(1, "Category name is required"),
});

// ── products ────────────────────────────────────────────────────────────────

export const productIdSchema = z.uuid("Product id is invalid");

export const productBaseSchema = z.object({
  name: trimmed(80).min(1, "Product name is required"),
  description: optionalText(400),
  categoryId: categoryIdSchema,
  sku: skuSchema,
  price: priceString,
  taxRate: taxRateString,
  foodType: z.enum(["veg", "non_veg"]),
  isAvailable: booleanSelect,
});

export type ProductBaseInput = z.infer<typeof productBaseSchema>;

/** Variant rows inside the product editor (parallel arrays). */
export const variantRowsSchema = z
  .object({
    variantId: z.array(z.string()),
    variantName: z.array(trimmed(60)),
    variantPrice: z.array(z.string()),
    variantSku: z.array(optionalText(32)),
  })
  .transform((raw, ctx) => {
    const rows: { id: string | null; name: string; priceMinor: number; sku: string | null }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < raw.variantName.length; i += 1) {
      const name = raw.variantName[i]?.trim() ?? "";
      const priceRaw = raw.variantPrice[i] ?? "";
      if (name === "" && priceRaw.trim() === "") continue;
      if (name === "") {
        ctx.addIssue({ code: "custom", message: `Variant ${i + 1}: name is required`, path: ["variantName"] });
        continue;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: `Duplicate variant name: ${name}`, path: ["variantName"] });
        continue;
      }
      seen.add(key);
      const price = priceToMinorUnits(priceRaw);
      if (price === null) {
        ctx.addIssue({ code: "custom", message: `"${name}": enter a price like 120 or 120.50`, path: ["variantPrice"] });
        continue;
      }
      const sku = raw.variantSku[i] ?? null;
      if (sku !== null && !SKU_PATTERN.test(sku)) {
        ctx.addIssue({ code: "custom", message: `"${name}": invalid SKU format`, path: ["variantSku"] });
        continue;
      }
      const idRaw = raw.variantId[i] ?? "";
      rows.push({ id: idRaw === "" ? null : idRaw, name, priceMinor: price, sku });
    }
    return { variants: rows };
  });

/** Outlet override rows inside the product editor. */
export const outletOverrideRowsSchema = z
  .object({
    overrideOutletId: z.array(z.uuid()),
    overridePrice: z.array(z.string()),
    overrideAvailable: z.array(z.enum(["yes", "no"])),
  })
  .transform((raw, ctx) => {
    const rows: { outletId: string; priceMinor: number | null; isAvailable: boolean }[] = [];
    for (let i = 0; i < raw.overrideOutletId.length; i += 1) {
      const outletId = raw.overrideOutletId[i];
      if (!outletId) continue;
      const priceRaw = (raw.overridePrice[i] ?? "").trim();
      let priceMinor: number | null = null;
      if (priceRaw !== "") {
        const parsed = priceToMinorUnits(priceRaw);
        if (parsed === null) {
          ctx.addIssue({ code: "custom", message: "Outlet price: enter a value like 120 or 120.50 (blank = base price)", path: ["overridePrice"] });
          continue;
        }
        priceMinor = parsed;
      }
      rows.push({
        outletId,
        priceMinor,
        isAvailable: (raw.overrideAvailable[i] ?? "yes") === "yes",
      });
    }
    return { overrides: rows };
  });

// ── modifier groups ─────────────────────────────────────────────────────────

export const modifierGroupIdSchema = z.uuid("Modifier group id is invalid");

const selectionCount = z
  .string()
  .trim()
  .regex(/^\d{1,2}$/, "Enter a whole number")
  .transform((v) => Number(v));

export const modifierGroupSchema = z
  .object({
    name: trimmed(60).min(1, "Group name is required"),
    minSelected: selectionCount,
    maxSelected: z.string().trim(),
  })
  .transform((raw, ctx) => {
    const maxRaw = raw.maxSelected === "" ? null : raw.maxSelected;
    let maxSelected: number | null = null;
    if (maxRaw !== null) {
      if (!/^\d{1,2}$/.test(maxRaw)) {
        ctx.addIssue({ code: "custom", message: "Max selections must be a whole number (blank = unlimited)", path: ["maxSelected"] });
      } else {
        maxSelected = Number(maxRaw);
      }
    }
    if (maxSelected !== null && maxSelected < raw.minSelected) {
      ctx.addIssue({ code: "custom", message: "Max selections cannot be below the minimum", path: ["maxSelected"] });
    }
    if (maxSelected === null && raw.minSelected > 0 && raw.minSelected > 20) {
      ctx.addIssue({ code: "custom", message: "Minimum selections capped at 20", path: ["minSelected"] });
    }
    return { name: raw.name, minSelected: raw.minSelected, maxSelected };
  });

export const modifierRowsSchema = z
  .object({
    modifierId: z.array(z.string()),
    modifierName: z.array(trimmed(60)),
    modifierPrice: z.array(z.string()),
  })
  .transform((raw, ctx) => {
    const rows: { id: string | null; name: string; priceMinor: number }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < raw.modifierName.length; i += 1) {
      const name = raw.modifierName[i]?.trim() ?? "";
      if (name === "") continue;
      const key = name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: `Duplicate option: ${name}`, path: ["modifierName"] });
        continue;
      }
      seen.add(key);
      const price = priceToMinorUnits(raw.modifierPrice[i] ?? "0");
      if (price === null) {
        ctx.addIssue({ code: "custom", message: `"${name}": enter a price like 0 or 25.50`, path: ["modifierPrice"] });
        continue;
      }
      rows.push({ id: raw.modifierId[i] || null, name, priceMinor: price });
    }
    return { modifiers: rows };
  });

// ── combos ──────────────────────────────────────────────────────────────────

export const comboIdSchema = z.uuid("Combo id is invalid");

export const comboSchema = z.object({
  name: trimmed(80).min(1, "Combo name is required"),
  description: optionalText(400),
  sku: skuSchema,
  price: priceString,
  taxRate: taxRateString,
  foodType: z.enum(["veg", "non_veg"]),
  isAvailable: booleanSelect,
});

export const comboItemRowsSchema = z
  .object({
    comboProductId: z.array(z.uuid("Pick a valid product")),
    comboVariantId: z.array(z.string()),
    comboQuantity: z.array(z.string()),
  })
  .transform((raw, ctx) => {
    const rows: { productId: string; variantId: string | null; quantity: number }[] = [];
    for (let i = 0; i < raw.comboProductId.length; i += 1) {
      const productId = raw.comboProductId[i];
      if (!productId) continue;
      const qtyRaw = raw.comboQuantity[i] ?? "1";
      if (!/^\d{1,2}$/.test(qtyRaw.trim())) {
        ctx.addIssue({ code: "custom", message: `Row ${i + 1}: quantity must be 1–20`, path: ["comboQuantity"] });
        continue;
      }
      const quantity = Number(qtyRaw.trim());
      if (quantity < 1 || quantity > 20) {
        ctx.addIssue({ code: "custom", message: `Row ${i + 1}: quantity must be 1–20`, path: ["comboQuantity"] });
        continue;
      }
      const variantRaw = raw.comboVariantId[i] ?? "";
      rows.push({ productId, variantId: variantRaw === "" ? null : variantRaw, quantity });
    }
    if (rows.length === 0) {
      ctx.addIssue({ code: "custom", message: "A combo needs at least one product", path: ["comboProductId"] });
    }
    if (rows.length > 20) {
      ctx.addIssue({ code: "custom", message: "At most 20 products per combo", path: ["comboProductId"] });
    }
    return { items: rows };
  });

// ── product list filters ────────────────────────────────────────────────────

export const productFiltersSchema = z.object({
  q: trimmed(80).optional().or(z.literal("")).transform((v) => (v ? v : null)),
  category: z.uuid().optional().or(z.literal("")).transform((v) => (v ?? null)).nullable(),
  availability: z.enum(["all", "available", "unavailable"]).catch("all"),
  food: z.enum(["all", "veg", "non_veg"]).catch("all"),
});

export type ProductFilters = z.infer<typeof productFiltersSchema>;

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
