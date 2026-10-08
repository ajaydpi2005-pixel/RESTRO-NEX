import { describe, expect, it } from "vitest";
import { assertMinor, formatMinor, minorToDecimalText, parseMoneyToMinor, sumMinor } from "@/lib/money";

describe("parseMoneyToMinor", () => {
  it("parses whole and fractional amounts exactly", () => {
    expect(parseMoneyToMinor("120")).toBe(12000);
    expect(parseMoneyToMinor("120.5")).toBe(12050);
    expect(parseMoneyToMinor("120.50")).toBe(12050);
    expect(parseMoneyToMinor("0.01")).toBe(1);
    expect(parseMoneyToMinor("0")).toBe(0);
  });

  it("avoids binary floating point drift (0.1 + 0.2 classic)", () => {
    expect(parseMoneyToMinor("0.1")).toBe(10);
    expect(parseMoneyToMinor("0.2")).toBe(20);
    expect(parseMoneyToMinor("0.3")).toBe(30);
    expect(sumMinor([parseMoneyToMinor("0.1")!, parseMoneyToMinor("0.2")!])).toBe(30);
  });

  it("accepts Indian grouping and a rupee sign", () => {
    expect(parseMoneyToMinor("1,234.5")).toBe(123450);
    expect(parseMoneyToMinor("₹ 99.99")).toBe(9999);
    expect(parseMoneyToMinor("  ₹1,00,000  ")).toBe(10000000);
  });

  it("rejects anything that is not an exact non-negative amount", () => {
    for (const bad of ["", " ", "abc", "-5", "1.234", "1.", ".5", "1e3", "12.3.4", "NaN", "Infinity"]) {
      expect(parseMoneyToMinor(bad), bad).toBeNull();
    }
    expect(parseMoneyToMinor(null)).toBeNull();
    expect(parseMoneyToMinor(undefined)).toBeNull();
  });

  it("refuses amounts beyond 11 whole digits", () => {
    expect(parseMoneyToMinor("99999999999")).toBe(9999999999900);
    expect(parseMoneyToMinor("999999999999")).toBeNull();
  });
});

describe("sumMinor / assertMinor", () => {
  it("sums integers and rejects non-integers", () => {
    expect(sumMinor([1, 2, 3])).toBe(6);
    expect(() => sumMinor([1.5])).toThrow(RangeError);
    expect(() => assertMinor(Number.NaN)).toThrow(RangeError);
  });

  it("throws when the total leaves the safe integer range", () => {
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});

describe("formatMinor", () => {
  it("formats with two decimals and Indian grouping", () => {
    expect(formatMinor(0)).toBe("0.00");
    expect(formatMinor(5)).toBe("0.05");
    expect(formatMinor(12050)).toBe("120.50");
    expect(formatMinor(123450)).toBe("1,234.50");
    expect(formatMinor(10000000)).toBe("1,00,000.00");
    expect(formatMinor(-1999)).toBe("-19.99");
  });
});

describe("minorToDecimalText", () => {
  it("renders plain decimals with two places and no grouping", () => {
    expect(minorToDecimalText(0)).toBe("0.00");
    expect(minorToDecimalText(5)).toBe("0.05");
    expect(minorToDecimalText(123450)).toBe("1234.50");
    expect(minorToDecimalText(-250)).toBe("-2.50");
  });

  it("round-trips through parseMoneyToMinor", () => {
    for (const minor of [0, 1, 99, 100, 1234567, 99999999]) {
      expect(parseMoneyToMinor(minorToDecimalText(minor))).toBe(minor);
    }
  });

  it("rejects non-integer input", () => {
    expect(() => minorToDecimalText(10.5)).toThrow();
  });
});
