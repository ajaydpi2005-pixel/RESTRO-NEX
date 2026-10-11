/**
 * Phase 13 — unit conversion. Mirrors `inventory_base_qty` in SQL (the
 * database is the authority; this copy exists so forms can preview and
 * tests can pin the rules). Every ingredient stores one base unit: grams,
 * millilitres or pieces. Purchases and recipes may use any compatible unit.
 */

export const INGREDIENT_BASE_UNITS = ["g", "ml", "pc"] as const;
export type IngredientBaseUnit = (typeof INGREDIENT_BASE_UNITS)[number];

export interface UnitDef {
  code: string;
  label: string;
  base: IngredientBaseUnit;
  /** How many base units one of this unit holds. */
  toBase: number;
}

export const UNITS: readonly UnitDef[] = [
  { code: "g", label: "g", base: "g", toBase: 1 },
  { code: "kg", label: "kg", base: "g", toBase: 1000 },
  { code: "ml", label: "ml", base: "ml", toBase: 1 },
  { code: "l", label: "l", base: "ml", toBase: 1000 },
  { code: "pc", label: "pc", base: "pc", toBase: 1 },
  { code: "dz", label: "dozen", base: "pc", toBase: 12 },
];

export function isIngredientBaseUnit(value: string): value is IngredientBaseUnit {
  return (INGREDIENT_BASE_UNITS as readonly string[]).includes(value);
}

/** Units a line may use for an ingredient stored in `base`. */
export function compatibleUnits(base: IngredientBaseUnit): UnitDef[] {
  return UNITS.filter((unit) => unit.base === base);
}

/**
 * Convert a quantity in `unit` into the ingredient's base unit.
 * Throws when the unit is unknown or belongs to a different family
 * (for example grams of a count ingredient).
 */
export function toBaseQty(ingredientUnit: string, unit: string, qty: number): number {
  if (!isIngredientBaseUnit(ingredientUnit)) throw new Error("Unknown ingredient unit.");
  const def = UNITS.find((u) => u.code === unit);
  if (!def) throw new Error(`Unknown unit "${unit}".`);
  if (def.base !== ingredientUnit) {
    throw new Error(`${def.label} does not match this ingredient (${ingredientUnit}).`);
  }
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantity must be more than zero.");
  return roundQty(qty * def.toBase);
}

/** Round to the 3 decimal places the ledger stores. */
export function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}
