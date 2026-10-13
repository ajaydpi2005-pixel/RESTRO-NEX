import { describe, expect, it } from "vitest";
import {
  couponSchema,
  customerSchema,
  loyaltySettingsSchema,
  pointsAdjustSchema,
  rewardSchema,
} from "@/modules/customers/schemas";

const BIZ = "cccccccc-0000-0000-0000-000000000001";
const CUST = "dddddddd-0000-0000-0000-000000000001";

describe("customerSchema", () => {
  const base = {
    businessId: BIZ,
    id: "",
    name: "Asha",
    phone: "+91 98765 43210",
    email: "",
    notes: "",
  };

  it("accepts a valid phone and blanks become absent", () => {
    const parsed = customerSchema.parse(base);
    expect(parsed.email).toBeUndefined();
    expect(parsed.id).toBeUndefined();
  });

  it("rejects letters and short numbers in the phone", () => {
    expect(customerSchema.safeParse({ ...base, phone: "call me" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...base, phone: "12345" }).success).toBe(false);
  });

  it("rejects a bad email", () => {
    expect(customerSchema.safeParse({ ...base, email: "not-an-email" }).success).toBe(false);
  });
});

describe("loyaltySettingsSchema", () => {
  it("reads the checkbox and converts the earn rate to paise", () => {
    const parsed = loyaltySettingsSchema.parse({
      businessId: BIZ,
      enabled: "on",
      earnRupeesPerPoint: "100.5",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.earnRupeesPerPoint).toBe(10050);
  });

  it("treats an unticked box as off and refuses zero or three decimals", () => {
    expect(loyaltySettingsSchema.parse({ businessId: BIZ, earnRupeesPerPoint: "10" }).enabled).toBe(
      false,
    );
    expect(
      loyaltySettingsSchema.safeParse({ businessId: BIZ, earnRupeesPerPoint: "0" }).success,
    ).toBe(false);
    expect(
      loyaltySettingsSchema.safeParse({ businessId: BIZ, earnRupeesPerPoint: "10.255" }).success,
    ).toBe(false);
  });
});

describe("rewardSchema", () => {
  const base = {
    businessId: BIZ,
    name: "Free chai",
    pointsCost: "50",
    discountType: "flat",
    discountValue: "50.5",
    maxDiscount: "",
    active: "on",
  };

  it("stores a flat amount in paise and a percent as a whole number", () => {
    expect(rewardSchema.parse(base).discountValueMinor).toBe(5050);
    expect(
      rewardSchema.parse({ ...base, discountType: "percent", discountValue: "15" })
        .discountValueMinor,
    ).toBe(15);
  });

  it("refuses a percent above 100 and a zero points cost", () => {
    expect(
      rewardSchema.safeParse({ ...base, discountType: "percent", discountValue: "101" }).success,
    ).toBe(false);
    expect(rewardSchema.safeParse({ ...base, pointsCost: "0" }).success).toBe(false);
  });
});

describe("couponSchema", () => {
  const base = {
    businessId: BIZ,
    code: "diwali10",
    name: "Diwali",
    discountType: "percent",
    discountValue: "10",
    maxDiscount: "",
    minSubtotal: "",
    startsOn: "",
    endsOn: "",
    usageLimit: "",
    perCustomerLimit: "",
    active: "on",
  };

  it("upper-cases the code and defaults the minimum to zero", () => {
    const parsed = couponSchema.parse(base);
    expect(parsed.code).toBe("DIWALI10");
    expect(parsed.minSubtotal).toBe(0);
  });

  it("refuses codes with spaces or symbols", () => {
    expect(couponSchema.safeParse({ ...base, code: "BAD CODE" }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, code: "AB" }).success).toBe(false);
  });

  it("refuses an end date before the start date", () => {
    expect(
      couponSchema.safeParse({ ...base, startsOn: "2026-11-01", endsOn: "2026-10-01" }).success,
    ).toBe(false);
  });
});

describe("pointsAdjustSchema", () => {
  const base = {
    businessId: BIZ,
    customerId: CUST,
    points: "5",
    reason: "Birthday gift",
    clientRef: "adj-0001-abcdef",
  };

  it("accepts a negative adjustment and refuses zero", () => {
    expect(pointsAdjustSchema.parse({ ...base, points: "-5" }).points).toBe(-5);
    expect(pointsAdjustSchema.safeParse({ ...base, points: "0" }).success).toBe(false);
  });

  it("needs a reason of at least three characters", () => {
    expect(pointsAdjustSchema.safeParse({ ...base, reason: "ok" }).success).toBe(false);
  });
});
