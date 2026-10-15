import { describe, expect, it } from "vitest";
import {
  describeFeatureValue,
  describeSource,
  endOfDayIst,
  formatCurrencyMinor,
  formatDate,
  formatDateTime,
  formatSeconds,
  pageFromParam,
  pageHref,
} from "./format";

describe("IST display", () => {
  it("shows a UTC instant in Asia/Kolkata (UTC+5:30)", () => {
    // 2026-10-15T00:00:00Z is 05:30 on the same day in IST.
    const text = formatDateTime("2026-10-15T00:00:00Z");
    expect(text).toMatch(/15 Oct 2026/);
    expect(text).toMatch(/05:30/);
  });

  it("reads empty values as Never and bad values as Unknown", () => {
    expect(formatDateTime(null)).toBe("Never");
    expect(formatDateTime("not a date")).toBe("Unknown");
    expect(formatDate(null)).toBe("—");
  });

  it("formats a date only, in IST", () => {
    expect(formatDate("2026-10-14T20:00:00Z")).toMatch(/15 Oct 2026/);
  });
});

describe("money", () => {
  it("formats minor units with the currency code and no mixing", () => {
    expect(formatCurrencyMinor("INR", 123450)).toBe("INR 1,234.50");
    expect(formatCurrencyMinor("USD", 5)).toBe("USD 0.05");
  });
});

describe("formatSeconds", () => {
  it("chooses seconds, minutes or hours", () => {
    expect(formatSeconds(45)).toBe("45 s");
    expect(formatSeconds(300)).toBe("5 min");
    expect(formatSeconds(7200)).toBe("2 h");
  });

  it("returns a dash when nothing was measured", () => {
    expect(formatSeconds(null)).toBe("—");
    expect(formatSeconds(undefined)).toBe("—");
  });
});

describe("endOfDayIst", () => {
  it("turns a date into the end of that day in IST", () => {
    expect(endOfDayIst("2026-10-29")).toBe("2026-10-29T23:59:59+05:30");
  });

  it("returns null for a blank date", () => {
    expect(endOfDayIst("")).toBeNull();
    expect(endOfDayIst("   ")).toBeNull();
    expect(endOfDayIst(undefined)).toBeNull();
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => endOfDayIst("29/10/2026")).toThrow(RangeError);
    expect(() => endOfDayIst("2026-02-30")).toThrow(RangeError);
    expect(() => endOfDayIst("2026-13-01")).toThrow(RangeError);
  });
});

describe("pagination", () => {
  it("reads page numbers and falls back to page 1", () => {
    expect(pageFromParam(undefined)).toEqual({ page: 1, offset: 0 });
    expect(pageFromParam("3")).toEqual({ page: 3, offset: 100 });
    expect(pageFromParam(["2", "9"])).toEqual({ page: 2, offset: 50 });
    expect(pageFromParam("abc")).toEqual({ page: 1, offset: 0 });
    expect(pageFromParam("0")).toEqual({ page: 1, offset: 0 });
    expect(pageFromParam("-4")).toEqual({ page: 1, offset: 0 });
  });

  it("caps very large page numbers", () => {
    expect(pageFromParam("99999999").page).toBe(10_000);
  });

  it("builds links that keep filters and omit empty values", () => {
    expect(pageHref("/admin/users", {}, 1)).toBe("/admin/users");
    expect(pageHref("/admin/users", { q: "a b", status: "" }, 2)).toBe("/admin/users?q=a+b&page=2");
  });
});

describe("feature display", () => {
  it("shows Off whatever the limit when a feature is not included", () => {
    expect(
      describeFeatureValue({ kind: "limit", included: false, limit_value: 5, unit: "outlets" }),
    ).toBe("Off");
  });

  it("shows On for boolean features and Unlimited for a null limit", () => {
    expect(
      describeFeatureValue({ kind: "boolean", included: true, limit_value: null, unit: null }),
    ).toBe("On");
    expect(
      describeFeatureValue({ kind: "limit", included: true, limit_value: null, unit: "outlets" }),
    ).toBe("Unlimited");
  });

  it("shows the limit with its unit", () => {
    expect(
      describeFeatureValue({ kind: "limit", included: true, limit_value: 1024, unit: "MB" }),
    ).toBe("1024 MB");
  });

  it("labels the source of a value", () => {
    expect(describeSource("override")).toBe("Override");
    expect(describeSource("plan")).toBe("Plan");
    expect(describeSource("none")).toBe("Not set");
  });
});
