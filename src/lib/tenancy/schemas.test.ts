import { describe, expect, it } from "vitest";
import { parseTenantSelection, uuidSchema } from "@/lib/tenancy/schemas";

describe("uuidSchema", () => {
  it("accepts well-formed UUIDs", () => {
    expect(uuidSchema.safeParse("00000000-0000-4000-8000-00000000000a").success).toBe(true);
  });

  it("rejects everything else", () => {
    for (const bad of ["", "tenant-a", "123", "00000000-0000-0000-0000-00000000000a-x", 42, null]) {
      expect(uuidSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("parseTenantSelection", () => {
  it("accepts a business-only selection", () => {
    const result = parseTenantSelection({ businessId: "00000000-0000-4000-8000-00000000000a" });
    expect(result.success).toBe(true);
  });

  it("accepts a business + outlet selection", () => {
    const result = parseTenantSelection({
      businessId: "00000000-0000-4000-8000-00000000000a",
      outletId: "00000000-0000-4000-8000-000000000a01",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing, malformed and tampered input", () => {
    expect(parseTenantSelection(undefined).success).toBe(false);
    expect(parseTenantSelection({}).success).toBe(false);
    expect(parseTenantSelection({ businessId: "tenant-a" }).success).toBe(false);
    expect(
      parseTenantSelection({
        businessId: "00000000-0000-4000-8000-00000000000a",
        outletId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});
