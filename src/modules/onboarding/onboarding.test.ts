import { describe, expect, it } from "vitest";
import {
  completionPercent,
  nextIncompleteStep,
  ONBOARDING_STEPS,
  resolveStep,
  stepAfter,
  stepStates,
} from "@/modules/onboarding/steps";
import {
  floorPlanSchema,
  kitchenStationsSchema,
  menuSetupSchema,
  priceToMinorUnits,
  staffInviteSchema,
  taxSettingsSchema,
} from "@/modules/onboarding/schemas";

describe("onboarding step registry", () => {
  it("lists the full wizard in product order", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "business", "type", "outlet", "settings", "tax",
      "tables", "kitchen", "menu", "staff", "finish",
    ]);
  });

  it("resumes at the first uncompleted step", () => {
    expect(nextIncompleteStep(["business"])).toBe("type");
    expect(nextIncompleteStep(["business", "type", "outlet"])).toBe("settings");
    expect(nextIncompleteStep([...ONBOARDING_STEPS])).toBe("finish");
  });

  it("never lands on a step whose prerequisites are missing", () => {
    // nothing done → must start at business even if 'menu' was requested
    expect(resolveStep("menu", [])).toBe("business");
    // business + type done but no outlet → tables bounces to the outlet step
    expect(resolveStep("tables", ["business", "type"])).toBe("outlet");
    // valid request with prerequisites satisfied passes through
    expect(resolveStep("tax", ["business", "type", "outlet"])).toBe("tax");
    // unknown step falls back to first incomplete
    expect(resolveStep("bogus", ["business"])).toBe("type");
  });

  it("computes completion percentage", () => {
    expect(completionPercent([])).toBe(0);
    expect(completionPercent(["business", "type", "outlet", "settings", "tax"])).toBe(50);
    expect(completionPercent([...ONBOARDING_STEPS])).toBe(100);
  });

  it("flags skippable steps as skipped once the wizard moves past them", () => {
    const states = stepStates("menu", ["business", "type", "outlet"]);
    expect(states.business).toBe("done");
    expect(states.settings).toBe("skipped");
    expect(states.tax).toBe("skipped");
    expect(states.tables).toBe("skipped");
    expect(states.menu).toBe("current");
    expect(states.staff).toBe("upcoming");
  });

  it("advances save & continue in order", () => {
    expect(stepAfter("type")).toBe("outlet");
    expect(stepAfter("staff")).toBe("finish");
    expect(stepAfter("finish")).toBe("finish");
  });
});

describe("price to minor units", () => {
  it("converts decimal strings exactly", () => {
    expect(priceToMinorUnits("120")).toBe(12000);
    expect(priceToMinorUnits("120.5")).toBe(12050);
    expect(priceToMinorUnits("120.50")).toBe(12050);
    expect(priceToMinorUnits("0.01")).toBe(1);
  });

  it("rejects malformed prices", () => {
    expect(priceToMinorUnits("abc")).toBeNull();
    expect(priceToMinorUnits("12.999")).toBeNull();
    expect(priceToMinorUnits("-5")).toBeNull();
    expect(priceToMinorUnits("")).toBeNull();
  });
});

describe("floor plan schema", () => {
  it("expands section rows into numbered tables", () => {
    const parsed = floorPlanSchema.parse({
      sectionName: ["Main hall", "Terrace"],
      tableCount: ["3", "2"],
      capacity: ["4", "2"],
    });
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]?.tables.map((t) => t.label)).toEqual(["T1", "T2", "T3"]);
    expect(parsed.sections[1]?.tables.map((t) => t.label)).toEqual(["T4", "T5"]);
    expect(parsed.sections[1]?.tables[0]?.capacity).toBe(2);
  });

  it("requires at least one real section", () => {
    const result = floorPlanSchema.safeParse({ sectionName: [""], tableCount: ["1"], capacity: ["4"] });
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range counts and capacities", () => {
    expect(
      floorPlanSchema.safeParse({ sectionName: ["A"], tableCount: ["0"], capacity: ["4"] }).success,
    ).toBe(false);
    expect(
      floorPlanSchema.safeParse({ sectionName: ["A"], tableCount: ["2"], capacity: ["51"] }).success,
    ).toBe(false);
  });
});

describe("kitchen stations schema", () => {
  it("collects named stations and skips empty rows", () => {
    const parsed = kitchenStationsSchema.parse({
      stationName: ["Hot kitchen", "", "Tandoor"],
      stationDescription: ["", "", "Clay oven"],
    });
    expect(parsed.stations).toEqual([
      { name: "Hot kitchen", description: null },
      { name: "Tandoor", description: "Clay oven" },
    ]);
  });

  it("rejects duplicate station names", () => {
    const result = kitchenStationsSchema.safeParse({
      stationName: ["Grill", "grill"],
      stationDescription: ["", ""],
    });
    expect(result.success).toBe(false);
  });
});

describe("menu setup schema", () => {
  it("groups items into categories case-insensitively and converts prices", () => {
    const parsed = menuSetupSchema.parse({
      categoryName: ["Starters", "starters", "Mains"],
      itemName: ["Soup", "Salad", "Biryani"],
      itemPrice: ["99.50", "120", "250"],
      itemFood: ["veg", "veg", "non_veg"],
      itemDescription: ["", "Garden fresh", ""],
    });
    expect(parsed.categories).toHaveLength(2);
    expect(parsed.categories[0]?.name).toBe("Starters");
    expect(parsed.categories[0]?.items).toHaveLength(2);
    expect(parsed.categories[0]?.items[0]?.price_minor).toBe(9950);
    expect(parsed.categories[1]?.items[0]?.is_vegetarian).toBe(false);
  });

  it("rejects rows with missing category or bad price", () => {
    const noCategory = menuSetupSchema.safeParse({
      categoryName: [""],
      itemName: ["Dish"],
      itemPrice: ["10"],
      itemFood: ["veg"],
      itemDescription: [""],
    });
    expect(noCategory.success).toBe(false);

    const badPrice = menuSetupSchema.safeParse({
      categoryName: ["Mains"],
      itemName: ["Dish"],
      itemPrice: ["ten"],
      itemFood: ["veg"],
      itemDescription: [""],
    });
    expect(badPrice.success).toBe(false);
  });
});

describe("tax settings schema", () => {
  it("parses enabled flag, rates and footer", () => {
    const parsed = taxSettingsSchema.parse({
      taxEnabled: "yes",
      taxNumber: "29ABCDE1234F1Z5",
      invoiceFooter: "Thank you",
      rateName: ["GST", ""],
      ratePct: ["5", "18"],
      rateInclusive: ["exclusive", "inclusive"],
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.rates).toEqual([
      { name: "GST", pct: 5, inclusive: false },
      { name: "Tax", pct: 18, inclusive: true },
    ]);
  });

  it("skips fully empty rows", () => {
    const parsed = taxSettingsSchema.parse({
      taxEnabled: "no",
      taxNumber: "",
      invoiceFooter: "",
      rateName: ["", "GST"],
      ratePct: ["", "5"],
      rateInclusive: ["exclusive", "exclusive"],
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.rates).toEqual([{ name: "GST", pct: 5, inclusive: false }]);
  });

  it("rejects percentages above 100", () => {
    const result = taxSettingsSchema.safeParse({
      taxEnabled: "yes",
      taxNumber: "",
      invoiceFooter: "",
      rateName: ["GST"],
      ratePct: ["101"],
      rateInclusive: ["exclusive"],
    });
    expect(result.success).toBe(false);
  });

  it("surfaces invalid rate percentages as errors when the row has a name", () => {
    const result = taxSettingsSchema.safeParse({
      taxEnabled: "yes",
      taxNumber: "",
      invoiceFooter: "",
      rateName: ["GST"],
      ratePct: ["abc"],
      rateInclusive: ["exclusive"],
    });
    expect(result.success).toBe(false);
  });
});

describe("staff invite schema", () => {
  const base = {
    email: "",
    role: "cashier" as const,
    outletId: ["a2a3b2c4-0000-4000-8000-000000000001"],
    expiryDays: "7" as const,
  };

  it("accepts a valid outlet-scoped invite", () => {
    const parsed = staffInviteSchema.parse(base);
    expect(parsed.role).toBe("cashier");
    expect(parsed.outletId).toHaveLength(1);
    expect(parsed.expiryDays).toBe(7);
  });

  it("rejects outlet-scoped roles without outlets", () => {
    const result = staffInviteSchema.safeParse({ ...base, outletId: [] });
    expect(result.success).toBe(false);
  });

  it("allows business admins without outlets", () => {
    const parsed = staffInviteSchema.safeParse({ ...base, role: "business_admin", outletId: [] });
    expect(parsed.success).toBe(true);
  });

  it("can never invite an owner", () => {
    const result = staffInviteSchema.safeParse({ ...base, role: "owner" });
    expect(result.success).toBe(false);
  });
});
