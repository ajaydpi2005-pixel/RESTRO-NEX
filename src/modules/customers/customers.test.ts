import { describe, expect, it } from "vitest";
import { customerPhoneKey, PHONE_PATTERN } from "@/modules/customers/phone";
import { segmentFor, SEGMENT_THRESHOLDS } from "@/modules/customers/segments";

const NOW = new Date("2026-10-13T06:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe("customerPhoneKey", () => {
  it("treats every format of the same Indian mobile as one customer", () => {
    expect(customerPhoneKey("+91 98765 43210")).toBe("9876543210");
    expect(customerPhoneKey("919876543210")).toBe("9876543210");
    expect(customerPhoneKey("98765-43210")).toBe("9876543210");
    expect(customerPhoneKey("(0) 9876543210")).toBe("9876543210");
  });

  it("keeps short numbers whole and refuses anything under seven digits", () => {
    expect(customerPhoneKey("1234567")).toBe("1234567");
    expect(customerPhoneKey("123456")).toBeNull();
    expect(customerPhoneKey("")).toBeNull();
    expect(customerPhoneKey(null)).toBeNull();
    expect(customerPhoneKey("abc")).toBeNull();
  });

  it("accepts the stored character set and rejects letters", () => {
    expect(PHONE_PATTERN.test("+91 98765 43210")).toBe(true);
    expect(PHONE_PATTERN.test("98765abcde")).toBe(false);
    expect(PHONE_PATTERN.test("123")).toBe(false);
  });
});

describe("segmentFor", () => {
  const base = { totalSpendMinor: 0, firstOrderAt: null, lastOrderAt: null, now: NOW };

  it("marks a customer with no completed order", () => {
    expect(segmentFor({ ...base, orderCount: 0 })).toBe("no_orders");
  });

  it("marks a first order within 30 days as new", () => {
    expect(
      segmentFor({ ...base, orderCount: 1, firstOrderAt: daysAgo(5), lastOrderAt: daysAgo(5) }),
    ).toBe("new");
  });

  it("does not call a single old order new", () => {
    expect(
      segmentFor({ ...base, orderCount: 1, firstOrderAt: daysAgo(45), lastOrderAt: daysAgo(45) }),
    ).toBe("occasional");
  });

  it("marks three or more recent orders as regular", () => {
    expect(
      segmentFor({
        ...base,
        orderCount: 3,
        firstOrderAt: daysAgo(90),
        lastOrderAt: daysAgo(10),
        totalSpendMinor: 50_000,
      }),
    ).toBe("regular");
  });

  it("marks ten orders, or big spend, as VIP while recently active", () => {
    expect(
      segmentFor({ ...base, orderCount: 10, firstOrderAt: daysAgo(200), lastOrderAt: daysAgo(3) }),
    ).toBe("vip");
    expect(
      segmentFor({
        ...base,
        orderCount: 2,
        firstOrderAt: daysAgo(100),
        lastOrderAt: daysAgo(3),
        totalSpendMinor: SEGMENT_THRESHOLDS.vipSpendMinor,
      }),
    ).toBe("vip");
  });

  it("moves a customer to at risk after 60 days and to lapsed after 180", () => {
    expect(
      segmentFor({ ...base, orderCount: 5, firstOrderAt: daysAgo(300), lastOrderAt: daysAgo(61) }),
    ).toBe("at_risk");
    expect(
      segmentFor({ ...base, orderCount: 5, firstOrderAt: daysAgo(300), lastOrderAt: daysAgo(181) }),
    ).toBe("lapsed");
  });

  it("lets recency outrank a long VIP history", () => {
    expect(
      segmentFor({
        ...base,
        orderCount: 40,
        firstOrderAt: daysAgo(900),
        lastOrderAt: daysAgo(200),
        totalSpendMinor: 9_000_000,
      }),
    ).toBe("lapsed");
  });
});
