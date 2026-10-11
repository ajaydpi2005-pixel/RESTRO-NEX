import { describe, expect, it } from "vitest";
import { compatibleUnits, roundQty, toBaseQty } from "@/modules/inventory/units";
import {
  addDays,
  expiryState,
  foodCostPct,
  marginPct,
  recipeCostMinor,
  rupeesToMinorUnitCost,
  stockStatus,
  unitCostRupees,
} from "@/modules/inventory/math";

describe("units", () => {
  it("converts every unit to the ingredient base", () => {
    expect(toBaseQty("g", "kg", 0.5)).toBe(500);
    expect(toBaseQty("ml", "l", 0.02)).toBe(20);
    expect(toBaseQty("pc", "dz", 1)).toBe(12);
    expect(toBaseQty("g", "g", 40)).toBe(40);
  });

  it("refuses unit families that do not match the ingredient", () => {
    expect(() => toBaseQty("pc", "g", 1)).toThrow(/does not match/);
    expect(() => toBaseQty("g", "l", 1)).toThrow(/does not match/);
    expect(() => toBaseQty("g", "furlong", 1)).toThrow(/Unknown unit/);
  });

  it("refuses non-positive quantities", () => {
    expect(() => toBaseQty("g", "g", 0)).toThrow(/more than zero/);
    expect(() => toBaseQty("g", "g", Number.NaN)).toThrow(/more than zero/);
  });

  it("lists only the units that fit an ingredient", () => {
    expect(compatibleUnits("g").map((u) => u.code)).toEqual(["g", "kg"]);
    expect(compatibleUnits("pc").map((u) => u.code)).toEqual(["pc", "dz"]);
  });

  it("rounds to three decimals like the ledger", () => {
    expect(roundQty(0.1 + 0.2)).toBe(0.3);
    expect(roundQty(1.23456)).toBe(1.235);
  });
});

describe("stock status", () => {
  it("reports out, low, ok and over in that order", () => {
    expect(stockStatus({ onHand: 0, minimum: 5, maximum: 10 })).toBe("out");
    expect(stockStatus({ onHand: -60, minimum: 5, maximum: 10 })).toBe("out");
    expect(stockStatus({ onHand: 4, minimum: 5, maximum: 10 })).toBe("low");
    expect(stockStatus({ onHand: 5, minimum: 5, maximum: 10 })).toBe("ok");
    expect(stockStatus({ onHand: 11, minimum: 5, maximum: 10 })).toBe("over");
  });

  it("never reports low without a minimum", () => {
    expect(stockStatus({ onHand: 1, minimum: null, maximum: null })).toBe("ok");
  });
});

describe("expiry", () => {
  it("flags expired, expiring within the window, and ok batches", () => {
    expect(expiryState("2026-10-11", "2026-10-12")).toBe("expired");
    expect(expiryState("2026-10-12", "2026-10-12")).toBe("expiring");
    expect(expiryState("2026-10-19", "2026-10-12")).toBe("expiring");
    expect(expiryState("2026-10-20", "2026-10-12")).toBe("ok");
    expect(expiryState(null, "2026-10-12")).toBe("none");
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2026-02-27", 1)).toBe("2026-02-28");
  });
});

describe("costs", () => {
  it("values a recipe at standard cost", () => {
    // burger: bun 1 pc × 100 + patty 1 pc × 1500 + cheese 40 g × 0.6 + sauce 20 ml × 0.2
    expect(
      recipeCostMinor([
        { quantity: 1, costPerUnit: 100 },
        { quantity: 1, costPerUnit: 1500 },
        { quantity: 40, costPerUnit: 0.6 },
        { quantity: 20, costPerUnit: 0.2 },
      ]),
    ).toBe(1628);
  });

  it("computes margin and food cost, and returns null when there is nothing to divide by", () => {
    expect(marginPct(20000, 5000)).toBe(75);
    expect(marginPct(0, 5000)).toBeNull();
    expect(foodCostPct(4910, 49100)).toBe(10);
    expect(foodCostPct(4910, 0)).toBeNull();
  });
});

describe("unit cost money", () => {
  it("stores rupees per unit as paise per unit, keeping sub-paise precision", () => {
    expect(rupeesToMinorUnitCost(0.6)).toBe(60); // ₹0.60 per g
    expect(rupeesToMinorUnitCost(1500)).toBe(150000); // ₹1500 per pc
    expect(rupeesToMinorUnitCost(0.0005)).toBe(0.05); // sub-paise survives
  });

  it("reads paise per unit back as rupees", () => {
    expect(unitCostRupees(60)).toBe(0.6);
    expect(unitCostRupees(0.05)).toBe(0.0005);
    expect(unitCostRupees(rupeesToMinorUnitCost(0.6))).toBe(0.6);
  });
});
