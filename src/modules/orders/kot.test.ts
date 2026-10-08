import { describe, expect, it } from "vitest";
import { buildKitchenTicket, type KotSourceOrder } from "@/modules/orders/kot";

const source: KotSourceOrder = {
  orderNumber: 42,
  orderType: "dine_in",
  tableName: "T4",
  customerName: null,
  outletName: "Main",
  createdAt: "2026-10-09T06:30:00.000Z",
  notes: "  Birthday, candles  ",
  items: [
    {
      name: "Paneer Tikka",
      quantity: 2,
      itemNotes: " less oil ",
      modifiers: [
        { name: "Extra mint chutney", quantity: 2 },
        { name: "Naan", quantity: 1 },
      ],
    },
    { name: "Masala Chai", quantity: 3, itemNotes: "   ", modifiers: [] },
  ],
};

describe("buildKitchenTicket", () => {
  it("keeps quantities, names and modifiers, with multiples spelled out", () => {
    const ticket = buildKitchenTicket(source);
    expect(ticket.lines[0]).toEqual({
      quantity: 2,
      name: "Paneer Tikka",
      modifiers: ["2 × Extra mint chutney", "Naan"],
      notes: "less oil",
    });
    expect(ticket.lines[1]).toEqual({ quantity: 3, name: "Masala Chai", modifiers: [], notes: null });
  });

  it("sums total quantity and trims order notes", () => {
    const ticket = buildKitchenTicket(source);
    expect(ticket.totalQuantity).toBe(5);
    expect(ticket.orderNotes).toBe("Birthday, candles");
    expect(ticket.tableName).toBe("T4");
  });

  it("never carries prices into the kitchen copy", () => {
    const serialised = JSON.stringify(buildKitchenTicket(source));
    expect(serialised).not.toMatch(/price|minor|amount|subtotal|"total"|tax|charge/i);
  });

  it("handles an empty order and a takeaway without a table", () => {
    const ticket = buildKitchenTicket({ ...source, items: [], tableName: null, notes: null });
    expect(ticket.lines).toEqual([]);
    expect(ticket.totalQuantity).toBe(0);
    expect(ticket.tableName).toBeNull();
    expect(ticket.orderNotes).toBeNull();
  });
});
