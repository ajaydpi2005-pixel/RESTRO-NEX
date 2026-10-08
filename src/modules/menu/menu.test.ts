import { describe, expect, it } from "vitest";
import { resolveMenuValues, sellableInOutlet } from "@/modules/menu/pricing";
import {
  comboItemRowsSchema,
  comboSchema,
  minorToDisplay,
  modifierGroupSchema,
  modifierRowsSchema,
  outletOverrideRowsSchema,
  priceToMinorUnits,
  productBaseSchema,
  productFiltersSchema,
  variantRowsSchema,
} from "@/modules/menu/schemas";

describe("price conversion", () => {
  it("converts exactly and round-trips display strings", () => {
    expect(priceToMinorUnits("120")).toBe(12000);
    expect(priceToMinorUnits("120.5")).toBe(12050);
    expect(priceToMinorUnits("0.01")).toBe(1);
    expect(minorToDisplay(12050)).toBe("120.50");
    expect(minorToDisplay(12000)).toBe("120");
  });
});

describe("outlet price/availability resolution", () => {
  const base = { priceMinor: 10000, isAvailable: true };

  it("falls back to base values without an override", () => {
    expect(resolveMenuValues(base, null)).toEqual({
      priceMinor: 10000,
      isAvailable: true,
      priceOverridden: false,
    });
  });

  it("applies outlet price overrides", () => {
    const resolved = resolveMenuValues(base, { priceMinor: 9000, isAvailable: true });
    expect(resolved.priceMinor).toBe(9000);
    expect(resolved.priceOverridden).toBe(true);
  });

  it("keeps base price when the override only touches availability", () => {
    const resolved = resolveMenuValues(base, { priceMinor: null, isAvailable: false });
    expect(resolved.priceMinor).toBe(10000);
    expect(resolved.isAvailable).toBe(false);
    expect(resolved.priceOverridden).toBe(false);
  });

  it("never sells a base-unavailable product even with a permissive override", () => {
    expect(sellableInOutlet({ ...base, isAvailable: false }, { priceMinor: null, isAvailable: true })).toBe(false);
  });
});

describe("product schema", () => {
  const valid = {
    name: "Paneer Tikka",
    description: "",
    categoryId: "a2a3b2c4-0000-4000-8000-000000000001",
    sku: "PNR-TIK-01",
    price: "249.50",
    taxRate: "5",
    foodType: "veg",
    isAvailable: "yes",
  };

  it("accepts a complete product and converts price/tax", () => {
    const parsed = productBaseSchema.parse(valid);
    expect(parsed.price).toBe(24950);
    expect(parsed.taxRate).toBe(5);
    expect(parsed.isAvailable).toBe(true);
  });

  it("treats blank sku and tax as inherit/unset", () => {
    const parsed = productBaseSchema.parse({ ...valid, sku: "", taxRate: "" });
    expect(parsed.sku).toBeNull();
    expect(parsed.taxRate).toBeNull();
  });

  it("rejects bad prices, skus and tax rates", () => {
    expect(productBaseSchema.safeParse({ ...valid, price: "abc" }).success).toBe(false);
    expect(productBaseSchema.safeParse({ ...valid, sku: "!!bad" }).success).toBe(false);
    expect(productBaseSchema.safeParse({ ...valid, taxRate: "150" }).success).toBe(false);
  });
});

describe("variant rows", () => {
  it("builds variant lists, skipping empty rows", () => {
    const parsed = variantRowsSchema.parse({
      variantId: ["vid-1", "", ""],
      variantName: ["Half", "Full", ""],
      variantPrice: ["150", "250", ""],
      variantSku: ["", "", ""],
    });
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.variants[0]).toEqual({ id: "vid-1", name: "Half", priceMinor: 15000, sku: null });
    expect(parsed.variants[1]?.id).toBeNull();
  });

  it("rejects duplicate variant names and bad prices", () => {
    const dup = variantRowsSchema.safeParse({
      variantId: ["", ""],
      variantName: ["Half", "half"],
      variantPrice: ["1", "2"],
      variantSku: ["", ""],
    });
    expect(dup.success).toBe(false);
    const badPrice = variantRowsSchema.safeParse({
      variantId: [""],
      variantName: ["Half"],
      variantPrice: ["cheap"],
      variantSku: [""],
    });
    expect(badPrice.success).toBe(false);
  });
});

describe("modifier group schema", () => {
  it("parses min/max with blank = unlimited", () => {
    const parsed = modifierGroupSchema.parse({ name: "Size", minSelected: "1", maxSelected: "" });
    expect(parsed).toEqual({ name: "Size", minSelected: 1, maxSelected: null });
  });

  it("rejects max below min", () => {
    const result = modifierGroupSchema.safeParse({ name: "Size", minSelected: "3", maxSelected: "1" });
    expect(result.success).toBe(false);
  });
});

describe("modifier rows", () => {
  it("parses options with default zero price", () => {
    const parsed = modifierRowsSchema.parse({
      modifierId: ["", ""],
      modifierName: ["Extra cheese", ""],
      modifierPrice: ["49.50", ""],
    });
    expect(parsed.modifiers).toEqual([{ id: null, name: "Extra cheese", priceMinor: 4950 }]);
  });

  it("rejects duplicate option names", () => {
    const result = modifierRowsSchema.safeParse({
      modifierId: ["", ""],
      modifierName: ["Same", "same"],
      modifierPrice: ["0", "0"],
    });
    expect(result.success).toBe(false);
  });
});

describe("outlet override rows", () => {
  it("blank price means base price; availability select persists", () => {
    const parsed = outletOverrideRowsSchema.parse({
      overrideOutletId: ["a2a3b2c4-0000-4000-8000-000000000001"],
      overridePrice: [""],
      overrideAvailable: ["no"],
    });
    expect(parsed.overrides).toEqual([
      {
        outletId: "a2a3b2c4-0000-4000-8000-000000000001",
        priceMinor: null,
        isAvailable: false,
      },
    ]);
  });

  it("rejects malformed override prices", () => {
    const result = outletOverrideRowsSchema.safeParse({
      overrideOutletId: ["a2a3b2c4-0000-4000-8000-000000000001"],
      overridePrice: ["ten"],
      overrideAvailable: ["yes"],
    });
    expect(result.success).toBe(false);
  });
});

describe("combo schemas", () => {
  const combo = {
    name: "Family Feast",
    description: "",
    sku: "",
    price: "799",
    taxRate: "",
    foodType: "non_veg",
    isAvailable: "yes",
  };

  it("parses combo fields", () => {
    const parsed = comboSchema.parse(combo);
    expect(parsed.price).toBe(79900);
    expect(parsed.foodType).toBe("non_veg");
  });

  it("requires at least one combo item and clamps quantity", () => {
    const empty = comboItemRowsSchema.safeParse({ comboProductId: [], comboVariantId: [], comboQuantity: [] });
    expect(empty.success).toBe(false);

    const tooMany = comboItemRowsSchema.safeParse({
      comboProductId: ["a2a3b2c4-0000-4000-8000-000000000001"],
      comboVariantId: [""],
      comboQuantity: ["21"],
    });
    expect(tooMany.success).toBe(false);

    const ok = comboItemRowsSchema.parse({
      comboProductId: ["a2a3b2c4-0000-4000-8000-000000000001"],
      comboVariantId: [""],
      comboQuantity: ["2"],
    });
    expect(ok.items).toEqual([
      { productId: "a2a3b2c4-0000-4000-8000-000000000001", variantId: null, quantity: 2 },
    ]);
  });
});

describe("product filters", () => {
  it("defaults and catches invalid enum values", () => {
    const parsed = productFiltersSchema.parse({ q: "", availability: "bogus", food: "all" });
    expect(parsed.q).toBeNull();
    expect(parsed.availability).toBe("all");
    expect(parsed.food).toBe("all");
  });
});
