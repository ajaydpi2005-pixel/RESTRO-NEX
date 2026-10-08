import { describe, expect, it } from "vitest";
import { computeOrderTotals } from "@/modules/orders/pricing";
import {
  allowedTransitions,
  canTransition,
  isOrderState,
} from "@/modules/orders/state";
import { posOrderPayloadSchema } from "@/modules/orders/schemas";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function basePayload(over: Record<string, unknown> = {}) {
  return {
    outletId: uuid(1),
    clientRef: "client-ref-abc-123",
    orderType: "takeaway",
    items: [
      { itemType: "product", productId: uuid(2), quantity: 2, modifiers: [] },
    ],
    ...over,
  };
}

// ── totals mirror ──────────────────────────────────────────────────────────

describe("computeOrderTotals", () => {
  it("sums lines with unit + modifier prices times quantity", () => {
    const totals = computeOrderTotals(
      [
        { unitPriceMinor: 10000, modifiersMinor: 2000, quantity: 3, taxPct: 0 },
        { unitPriceMinor: 500, modifiersMinor: 0, quantity: 2, taxPct: 0 },
      ],
      { type: "none", value: 0 },
      [],
    );
    expect(totals.subtotalMinor).toBe(37000);
    expect(totals.discountMinor).toBe(0);
    expect(totals.taxMinor).toBe(0);
    expect(totals.totalMinor).toBe(37000);
  });

  it("applies percentage discounts with rounding", () => {
    const totals = computeOrderTotals(
      [{ unitPriceMinor: 9999, modifiersMinor: 0, quantity: 1, taxPct: 0 }],
      { type: "percent", value: 10 },
      [],
    );
    expect(totals.discountMinor).toBe(1000); // round(999.9)
    expect(totals.totalMinor).toBe(8999);
  });

  it("caps flat discounts at the subtotal", () => {
    const totals = computeOrderTotals(
      [{ unitPriceMinor: 300, modifiersMinor: 0, quantity: 1, taxPct: 0 }],
      { type: "flat", value: 5000 },
      [],
    );
    expect(totals.discountMinor).toBe(300);
    expect(totals.totalMinor).toBe(0);
  });

  it("computes exclusive tax on the net (post-discount) amount pro-rata", () => {
    // line A gross 6000, line B gross 4000, 50% discount, 5% tax on lines
    const totals = computeOrderTotals(
      [
        { unitPriceMinor: 6000, modifiersMinor: 0, quantity: 1, taxPct: 5 },
        { unitPriceMinor: 4000, modifiersMinor: 0, quantity: 1, taxPct: 5 },
      ],
      { type: "percent", value: 50 },
      [],
    );
    expect(totals.subtotalMinor).toBe(10000);
    expect(totals.discountMinor).toBe(5000);
    // shares 3000/2000 → net 3000 + 2000 → tax 150 + 100
    expect(totals.taxMinor).toBe(250);
    expect(totals.totalMinor).toBe(5250);
  });

  it("adds charges on top of the taxed amount", () => {
    const totals = computeOrderTotals(
      [{ unitPriceMinor: 10000, modifiersMinor: 0, quantity: 1, taxPct: 10 }],
      { type: "none", value: 0 },
      [500, 100],
    );
    expect(totals.taxMinor).toBe(1000);
    expect(totals.chargesMinor).toBe(600);
    expect(totals.totalMinor).toBe(11600);
  });

  it("handles an empty order without dividing by zero", () => {
    const totals = computeOrderTotals([], { type: "percent", value: 50 }, [0]);
    expect(totals.totalMinor).toBe(0);
  });
});

// ── state machine ──────────────────────────────────────────────────────────

describe("order state machine", () => {
  it("allows the documented lifecycle", () => {
    expect(canTransition("open", "held")).toBe(true);
    expect(canTransition("held", "open")).toBe(true);
    expect(canTransition("open", "placed")).toBe(true);
    expect(canTransition("placed", "preparing")).toBe(true);
    expect(canTransition("preparing", "ready")).toBe(true);
    expect(canTransition("ready", "completed")).toBe(true);
  });

  it("allows cancellation until ready", () => {
    expect(canTransition("open", "cancelled")).toBe(true);
    expect(canTransition("held", "cancelled")).toBe(true);
    expect(canTransition("placed", "cancelled")).toBe(true);
    expect(canTransition("preparing", "cancelled")).toBe(true);
    expect(canTransition("ready", "cancelled")).toBe(false);
  });

  it("blocks skips and backwards moves", () => {
    expect(canTransition("open", "preparing")).toBe(false);
    expect(canTransition("open", "completed")).toBe(false);
    expect(canTransition("placed", "open")).toBe(false);
    expect(canTransition("preparing", "placed")).toBe(false);
    expect(canTransition("completed", "open")).toBe(false);
    expect(canTransition("cancelled", "open")).toBe(false);
  });

  it("exposes transitions for UI controls", () => {
    expect(allowedTransitions("held")).toEqual(["open", "placed", "cancelled"]);
    expect(allowedTransitions("completed")).toEqual([]);
    expect(allowedTransitions("cancelled")).toEqual([]);
  });

  it("guards the state type", () => {
    expect(isOrderState("open")).toBe(true);
    expect(isOrderState("billed")).toBe(false);
    expect(isOrderState(42)).toBe(false);
  });
});

// ── POS payload schemas ────────────────────────────────────────────────────

describe("posOrderPayloadSchema", () => {
  it("accepts a minimal takeaway order", () => {
    expect(posOrderPayloadSchema.safeParse(basePayload()).success).toBe(true);
  });

  it("requires a table for dine-in", () => {
    const result = posOrderPayloadSchema.safeParse(basePayload({ orderType: "dine_in" }));
    expect(result.success).toBe(false);
    const withTable = posOrderPayloadSchema.safeParse(basePayload({ orderType: "dine_in", tableId: uuid(3) }));
    expect(withTable.success).toBe(true);
  });

  it("requires phone + address for delivery", () => {
    expect(posOrderPayloadSchema.safeParse(basePayload({ orderType: "delivery" })).success).toBe(false);
    const full = posOrderPayloadSchema.safeParse(
      basePayload({
        orderType: "delivery",
        customerPhone: "+91 98765 43210",
        deliveryAddress: "12, Anna Salai, Chennai",
      }),
    );
    expect(full.success).toBe(true);
  });

  it("rejects percentage discounts above 100", () => {
    const result = posOrderPayloadSchema.safeParse(
      basePayload({ discount: { type: "percent", value: 150 } }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range quantities", () => {
    expect(
      posOrderPayloadSchema.safeParse(
        basePayload({ items: [{ itemType: "product", productId: uuid(2), quantity: 0 }] }),
      ).success,
    ).toBe(false);
    expect(
      posOrderPayloadSchema.safeParse(
        basePayload({ items: [{ itemType: "product", productId: uuid(2), quantity: 100 }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects combos with variants and items without ids", () => {
    expect(
      posOrderPayloadSchema.safeParse(
        basePayload({
          items: [{ itemType: "combo", comboId: uuid(4), variantId: uuid(5), quantity: 1 }],
        }),
      ).success,
    ).toBe(false);
    expect(
      posOrderPayloadSchema.safeParse(
        basePayload({ items: [{ itemType: "product", quantity: 1 }] }),
      ).success,
    ).toBe(false);
  });

  it("enforces item and charge limits", () => {
    const manyItems = Array.from({ length: 101 }, () => ({
      itemType: "product",
      productId: uuid(2),
      quantity: 1,
    }));
    expect(posOrderPayloadSchema.safeParse(basePayload({ items: manyItems })).success).toBe(false);

    const manyCharges = Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, amountMinor: 100 }));
    expect(posOrderPayloadSchema.safeParse(basePayload({ charges: manyCharges })).success).toBe(false);
  });

  it("normalises blank strings to null", () => {
    const result = posOrderPayloadSchema.safeParse(
      basePayload({ customerName: "   ", notes: "" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customerName).toBeNull();
      expect(result.data.notes).toBeNull();
      expect(result.data.discount).toEqual({ type: "none", value: 0 });
      expect(result.data.charges).toEqual([]);
    }
  });
});
