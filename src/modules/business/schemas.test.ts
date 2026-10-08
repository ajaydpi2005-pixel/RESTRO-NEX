import { describe, expect, it } from "vitest";
import {
  createBusinessSchema,
  createOutletSchema,
  setOutletStatusSchema,
  slugify,
  updateOutletSchema,
} from "@/modules/business/schemas";

const validBusiness = {
  name: "Spice Route Hospitality",
  restaurantType: "casual_dining",
  currency: "INR",
  timezone: "Asia/Kolkata",
  email: "hello@spiceroute.example",
  phone: "+91 98765 43210",
  addressLine1: "12 Anna Salai",
  addressLine2: "",
  city: "Chennai",
  state: "Tamil Nadu",
  postalCode: "600002",
  country: "India",
  taxNumber: "33ABCDE1234F1Z5",
  logoUrl: "https://cdn.example.com/logo.png",
};

describe("slugify", () => {
  it("creates URL-safe slugs", () => {
    expect(slugify("Spice Route Hospitality")).toBe("spice-route-hospitality");
    expect(slugify("  Café   Déli!!! ")).toBe("cafe-deli");
    expect(slugify("x")).toBe("restaurant"); // too short → safe fallback
  });
});

describe("createBusinessSchema", () => {
  it("accepts a complete valid business", () => {
    expect(createBusinessSchema.safeParse(validBusiness).success).toBe(true);
  });

  it("normalises empty strings to null", () => {
    const result = createBusinessSchema.safeParse({ ...validBusiness, addressLine2: "", phone: "" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.addressLine2).toBeNull();
      expect(result.data.phone).toBeNull();
    }
  });

  it("rejects invalid fields", () => {
    expect(createBusinessSchema.safeParse({ ...validBusiness, name: "a" }).success).toBe(false);
    expect(createBusinessSchema.safeParse({ ...validBusiness, restaurantType: "space_food" }).success).toBe(false);
    expect(createBusinessSchema.safeParse({ ...validBusiness, currency: "ZZZ" }).success).toBe(false);
    expect(createBusinessSchema.safeParse({ ...validBusiness, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(createBusinessSchema.safeParse({ ...validBusiness, email: "not-an-email" }).success).toBe(false);
    expect(createBusinessSchema.safeParse({ ...validBusiness, phone: "call me maybe" }).success).toBe(false);
    expect(createBusinessSchema.safeParse({ ...validBusiness, taxNumber: "has spaces!" }).success).toBe(false);
    expect(createBusinessSchema.safeParse({ ...validBusiness, logoUrl: "javascript:alert(1)" }).success).toBe(false);
  });
});

const validOutlet = {
  businessId: "11111111-1111-4111-8111-111111111111",
  name: "Anna Nagar",
  code: "out-01",
  email: "annanagar@spiceroute.example",
  phone: "+91 44 1234 5678",
  addressLine1: "2nd Avenue",
  addressLine2: "",
  city: "Chennai",
  state: "Tamil Nadu",
  postalCode: "600040",
  country: "India",
  orderTypes: ["dine_in", "takeaway"],
  operatingHours: { mon: { open: "09:00", close: "22:00" }, sun: null },
};

describe("createOutletSchema", () => {
  it("accepts a valid outlet and uppercases the code", () => {
    const result = createOutletSchema.safeParse(validOutlet);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe("OUT-01");
    }
  });

  it("requires at least one order type", () => {
    expect(createOutletSchema.safeParse({ ...validOutlet, orderTypes: [] }).success).toBe(false);
  });

  it("rejects unknown order types and bad codes", () => {
    expect(createOutletSchema.safeParse({ ...validOutlet, orderTypes: ["buffet"] }).success).toBe(false);
    expect(createOutletSchema.safeParse({ ...validOutlet, code: "-bad" }).success).toBe(false);
    expect(createOutletSchema.safeParse({ ...validOutlet, code: "WAY_TOO_LONG_CODE_99" }).success).toBe(false);
  });

  it("validates operating hours strictly", () => {
    expect(
      createOutletSchema.safeParse({
        ...validOutlet,
        operatingHours: { mon: { open: "9am", close: "22:00" } },
      }).success,
    ).toBe(false);
    expect(
      createOutletSchema.safeParse({ ...validOutlet, operatingHours: { monday: null } }).success,
    ).toBe(false);
  });
});

describe("updateOutletSchema / setOutletStatusSchema", () => {
  it("updates require the outlet id but not the business id", () => {
    const rest = { ...validOutlet } as Record<string, unknown>;
    delete rest["businessId"];
    expect(
      updateOutletSchema.safeParse({ ...rest, outletId: "22222222-2222-4222-8222-222222222222" })
        .success,
    ).toBe(true);
  });

  it("coerces the active flag from form strings", () => {
    const on = setOutletStatusSchema.safeParse({
      outletId: "22222222-2222-4222-8222-222222222222",
      active: "true",
    });
    const off = setOutletStatusSchema.safeParse({
      outletId: "22222222-2222-4222-8222-222222222222",
      active: "false",
    });
    expect(on.success && on.data.active).toBe(true);
    expect(off.success && off.data.active).toBe(false);
  });
});
