import { z } from "zod";
import { INGREDIENT_BASE_UNITS } from "@/modules/inventory/units";

/**
 * Phase 13 — input schemas for inventory and recipe forms. Client input is
 * never trusted for money or permission: the server actions re-check the
 * session and the RPCs re-check permissions and recompute every quantity.
 */

const uuid = z.string().uuid("Choose a valid option.");
const money = z.coerce.number().min(0, "Cannot be negative.").max(1e8, "Too large.");
const qty = z.coerce
  .number({ error: "Enter a quantity." })
  .positive("Quantity must be more than zero.")
  .max(1e9, "Quantity is too large.");
const reason = z.string().trim().min(1, "Give a reason.").max(120, "Keep the reason under 120 characters.");
const clientRef = z.string().trim().min(8).max(80);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date.")
  .optional()
  .or(z.literal("").transform(() => undefined));

export const ingredientSchema = z
  .object({
    businessId: uuid,
    id: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
    name: z.string().trim().min(1, "Name is required.").max(80),
    unit: z.enum(INGREDIENT_BASE_UNITS, { error: "Choose g, ml or pc." }),
    costPerUnit: money,
    minimumStock: money.optional().or(z.literal("").transform(() => undefined)),
    maximumStock: money.optional().or(z.literal("").transform(() => undefined)),
    active: z.boolean(),
  })
  .refine((v) => v.minimumStock === undefined || v.maximumStock === undefined || v.maximumStock >= v.minimumStock, {
    message: "Maximum must be at least the minimum.",
    path: ["maximumStock"],
  });

export const receiveSchema = z.object({
  outletId: uuid,
  ingredientId: uuid,
  qty,
  unit: z.string().min(1).max(4),
  unitCost: money,
  batchCode: z.string().trim().max(40).optional().or(z.literal("").transform(() => undefined)),
  expiresOn: isoDate,
  clientRef,
});

export const wasteSchema = z.object({
  outletId: uuid,
  ingredientId: uuid,
  qty,
  unit: z.string().min(1).max(4),
  reason,
  clientRef,
});

export const countSchema = z.object({
  outletId: uuid,
  ingredientId: uuid,
  counted: z.coerce.number({ error: "Enter the counted amount." }).min(0, "A count cannot be negative.").max(1e9),
  unit: z.string().min(1).max(4),
  reason,
  clientRef,
});

const transferLine = z.object({
  ingredientId: uuid,
  unit: z.string().min(1).max(4),
  qty,
});

export const transferSchema = z
  .object({
    fromOutletId: uuid,
    toOutletId: uuid,
    note: z.string().trim().max(200).optional().or(z.literal("").transform(() => undefined)),
    lines: z.array(transferLine).min(1, "Add at least one line.").max(20, "At most 20 lines per transfer."),
    clientRef,
  })
  .refine((v) => v.fromOutletId !== v.toOutletId, {
    message: "Choose two different outlets.",
    path: ["toOutletId"],
  });

export const recipeLineSchema = z.object({
  ingredientId: uuid,
  unit: z.string().min(1).max(4),
  qty,
});

export const recipeSchema = z.object({
  businessId: uuid,
  menuItemId: uuid,
  lines: z.array(recipeLineSchema).max(60, "At most 60 ingredients per recipe."),
});

/** Forms post their line lists as JSON in a hidden field. */
export function parseJsonLines(raw: FormDataEntryValue | null | undefined): unknown {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
