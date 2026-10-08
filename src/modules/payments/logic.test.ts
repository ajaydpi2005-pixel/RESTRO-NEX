import { describe, expect, it } from "vitest";
import {
  balanceDueMinor,
  cashChangeMinor,
  derivePaymentStatus,
  refundableMinor,
  summarisePaymentDraft,
  type PaymentDraftLine,
} from "@/modules/payments/logic";

const line = (over: Partial<PaymentDraftLine> = {}): PaymentDraftLine => ({
  key: "k1",
  methodKey: "cash",
  methodLabel: "Cash",
  kind: "cash",
  requiresReference: false,
  amountText: "100",
  tenderedText: "",
  reference: "",
  ...over,
});

describe("derivePaymentStatus (mirrors the DB derive_payment_status)", () => {
  it("walks unpaid → partial → paid", () => {
    expect(derivePaymentStatus(10000, 0, 0)).toBe("unpaid");
    expect(derivePaymentStatus(10000, 4000, 0)).toBe("partial");
    expect(derivePaymentStatus(10000, 10000, 0)).toBe("paid");
  });

  it("uses net of refunds: partial refund stays partial, full reversal is refunded", () => {
    expect(derivePaymentStatus(10000, 10000, 0)).toBe("paid");
    expect(derivePaymentStatus(10000, 10000, 1000)).toBe("partial"); // net 9000 < 10000
    expect(derivePaymentStatus(10000, 4000, 1000)).toBe("partial");
    expect(derivePaymentStatus(10000, 10000, 10000)).toBe("refunded");
  });

  it("treats a zero-value bill as paid", () => {
    expect(derivePaymentStatus(0, 0, 0)).toBe("paid");
  });
});

describe("balance, refundable and change", () => {
  it("balance never goes negative", () => {
    expect(balanceDueMinor(10000, 4000, 0)).toBe(6000);
    expect(balanceDueMinor(10000, 10000, 0)).toBe(0);
    expect(balanceDueMinor(10000, 12000, 0)).toBe(0);
    expect(balanceDueMinor(10000, 10000, 3000)).toBe(3000);
  });

  it("refundable is capped at what is left on the payment", () => {
    expect(refundableMinor(5000, 1000)).toBe(4000);
    expect(refundableMinor(5000, 5000)).toBe(0);
  });

  it("computes cash change and refuses short tender", () => {
    expect(cashChangeMinor(5000, 6000)).toBe(1000);
    expect(cashChangeMinor(5000, 5000)).toBe(0);
    expect(() => cashChangeMinor(5000, 4999)).toThrow(RangeError);
  });
});

describe("summarisePaymentDraft", () => {
  it("totals a valid split with change and allows submit", () => {
    const summary = summarisePaymentDraft(
      [
        line({ amountText: "50", tenderedText: "60" }),
        line({ key: "k2", methodKey: "upi", methodLabel: "UPI", kind: "upi", requiresReference: true, amountText: "40", reference: "UTR1" }),
      ],
      100_00,
    );
    expect(summary.totalMinor).toBe(9000);
    expect(summary.changeMinor).toBe(1000);
    expect(summary.errors).toEqual([]);
    expect(summary.canSubmit).toBe(true);
  });

  it("blocks overpayment against the balance", () => {
    const summary = summarisePaymentDraft([line({ amountText: "101" })], 10000);
    expect(summary.canSubmit).toBe(false);
    expect(summary.errors.join(" ")).toMatch(/more than the balance/);
  });

  it("blocks zero, malformed and under-tendered lines with clear messages", () => {
    const zero = summarisePaymentDraft([line({ amountText: "0" })], 10000);
    expect(zero.canSubmit).toBe(false);
    const malformed = summarisePaymentDraft([line({ amountText: "1.234" })], 10000);
    expect(malformed.errors[0]).toMatch(/greater than zero/);
    const short = summarisePaymentDraft([line({ amountText: "50", tenderedText: "40" })], 10000);
    expect(short.errors[0]).toMatch(/at least the amount/);
  });

  it("requires a reference for UPI and card lines", () => {
    const summary = summarisePaymentDraft(
      [line({ methodKey: "card", methodLabel: "Card", kind: "card", requiresReference: true, amountText: "10" })],
      10000,
    );
    expect(summary.errors).toContain("Card: enter a reference.");
  });

  it("refuses an empty draft and a due-less bill", () => {
    expect(summarisePaymentDraft([], 10000).canSubmit).toBe(false);
    expect(summarisePaymentDraft([line()], 0).errors).toContain("Nothing is due on this bill.");
  });
});
