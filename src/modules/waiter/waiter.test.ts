import { describe, expect, it } from "vitest";
import type { PosCombo, PosProduct } from "@/modules/orders/queries";
import {
  buildComboLine,
  buildProductLine,
  checkProductSelection,
  draftStorageKey,
  estimateTotalMinor,
  itemCount,
  lineEstimateMinor,
  parseDraft,
  removeLine,
  serializeDraft,
  setLineNote,
  setLineQuantity,
  toSubmissionItems,
  type WaiterLine,
} from "@/modules/waiter/cart";
import { toDbSubmitPayload, waiterSubmitSchema } from "@/modules/waiter/schemas";
import {
  isPosDraftState,
  isSentOrderState,
  kitchenTone,
  readyItemCount,
} from "@/modules/waiter/status";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function product(overrides: Partial<PosProduct> = {}): PosProduct {
  return {
    id: UUID(1),
    name: "Burger",
    categoryId: UUID(90),
    priceMinor: 10000,
    isVegetarian: false,
    isAvailable: true,
    imagePath: null,
    taxRatePct: 5,
    effectivePriceMinor: 10000,
    outletAvailable: true,
    variants: [],
    modifierGroups: [],
    ...overrides,
  };
}

const cheese = { id: UUID(10), name: "Cheese", priceMinor: 2000 };
const bacon = { id: UUID(11), name: "Bacon", priceMinor: 3000 };
const toppings = {
  id: UUID(20),
  name: "Toppings",
  minSelected: 0,
  maxSelected: 1,
  modifiers: [cheese, bacon],
};
const sizes = [
  { id: UUID(30), name: "Regular", priceMinor: 10000, isAvailable: true },
  { id: UUID(31), name: "Large", priceMinor: 14000, isAvailable: true },
];

describe("checkProductSelection", () => {
  it("accepts a plain product with no options", () => {
    expect(checkProductSelection(product(), { variantId: null, modifierIds: [], quantity: 1, itemNotes: "" })).toEqual({ ok: true });
  });

  it("requires a variant when the product has variants", () => {
    const p = product({ variants: sizes });
    const result = checkProductSelection(p, { variantId: null, modifierIds: [], quantity: 1, itemNotes: "" });
    expect(result.ok).toBe(false);
  });

  it("refuses an unavailable variant", () => {
    const p = product({ variants: [{ ...sizes[0]!, isAvailable: false }] });
    const result = checkProductSelection(p, { variantId: sizes[0]!.id, modifierIds: [], quantity: 1, itemNotes: "" });
    expect(result).toMatchObject({ ok: false });
  });

  it("enforces a required group's minimum", () => {
    const p = product({ modifierGroups: [{ ...toppings, minSelected: 1, maxSelected: 1 }] });
    const result = checkProductSelection(p, { variantId: null, modifierIds: [], quantity: 1, itemNotes: "" });
    expect(result).toEqual({ ok: false, errors: ["Toppings: choose at least 1."] });
  });

  it("enforces a group's maximum", () => {
    const p = product({ modifierGroups: [toppings] });
    const result = checkProductSelection(p, { variantId: null, modifierIds: [cheese.id, bacon.id], quantity: 1, itemNotes: "" });
    expect(result).toEqual({ ok: false, errors: ["Toppings: choose at most 1."] });
  });

  it("rejects quantities and notes out of range", () => {
    const p = product();
    expect(checkProductSelection(p, { variantId: null, modifierIds: [], quantity: 0, itemNotes: "" }).ok).toBe(false);
    expect(checkProductSelection(p, { variantId: null, modifierIds: [], quantity: 100, itemNotes: "" }).ok).toBe(false);
    expect(checkProductSelection(p, { variantId: null, modifierIds: [], quantity: 1, itemNotes: "x".repeat(201) }).ok).toBe(false);
  });
});

describe("cart lines and estimates", () => {
  it("builds a product line with the chosen variant, options and trimmed note", () => {
    const p = product({ variants: sizes, modifierGroups: [toppings] });
    const line = buildProductLine(
      p,
      { variantId: sizes[1]!.id, modifierIds: [cheese.id], quantity: 2, itemNotes: "  no onion " },
      "k1",
    );
    expect(line).toMatchObject({
      itemType: "product",
      productId: p.id,
      variantId: sizes[1]!.id,
      name: "Burger (Large)",
      unitPriceMinor: 14000,
      quantity: 2,
      itemNotes: "no onion",
    });
    expect(line.modifiers).toEqual([{ modifierId: cheese.id, name: "Cheese", priceMinor: 2000 }]);
  });

  it("estimates each line as (unit + options) × quantity, and totals the cart", () => {
    const a = buildProductLine(product({ modifierGroups: [toppings] }), { variantId: null, modifierIds: [cheese.id], quantity: 2, itemNotes: "" }, "a");
    const b = buildComboLine({ id: UUID(50), name: "Meal", priceMinor: 5000, isVegetarian: false, isAvailable: true, imagePath: null } as PosCombo, 1, "", "b");
    expect(lineEstimateMinor(a)).toBe((10000 + 2000) * 2);
    expect(estimateTotalMinor([a, b])).toBe(24000 + 5000);
    expect(itemCount([a, b])).toBe(3);
  });

  it("clamps quantity, drops lines, and updates notes", () => {
    const line = buildComboLine({ id: UUID(50), name: "Meal", priceMinor: 500, isVegetarian: false, isAvailable: true, imagePath: null } as PosCombo, 1, "", "x");
    let lines: WaiterLine[] = [line];
    lines = setLineQuantity(lines, "x", 500);
    expect(lines[0]!.quantity).toBe(99);
    lines = setLineQuantity(lines, "x", 0);
    expect(lines[0]!.quantity).toBe(1);
    lines = setLineNote(lines, "x", "  extra ice  ");
    expect(lines[0]!.itemNotes).toBe("extra ice");
    expect(removeLine(lines, "x")).toEqual([]);
  });
});

describe("submission payload", () => {
  const sample = (): WaiterLine[] => [
    buildProductLine(
      product({ modifierGroups: [toppings] }),
      { variantId: null, modifierIds: [bacon.id], quantity: 2, itemNotes: "" },
      "a",
    ),
  ];

  it("sends ids and quantities only — never prices, discounts or charges", () => {
    const items = toSubmissionItems(sample());
    expect(items[0]).toEqual({
      itemType: "product",
      productId: UUID(1),
      comboId: null,
      variantId: null,
      quantity: 2,
      itemNotes: "",
      modifiers: [{ modifierId: bacon.id, quantity: 1 }],
    });
    expect(JSON.stringify(items)).not.toMatch(/price|discount|charge/i);
  });

  const base = () => ({
    outletId: UUID(100),
    clientRef: "waiter-ref-0001",
    tableId: UUID(101),
    orderId: null,
    notes: "  window  ",
    send: true,
    items: toSubmissionItems(sample()),
  });

  it("accepts a valid new-order submission and maps it to the RPC shape", () => {
    const parsed = waiterSubmitSchema.safeParse(base());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const db = toDbSubmitPayload(parsed.data);
    expect(db).toMatchObject({
      outlet_id: UUID(100),
      client_ref: "waiter-ref-0001",
      table_id: UUID(101),
      order_id: null,
      order_type: "dine_in",
      notes: "window",
    });
    expect(db.items[0]).toMatchObject({ item_type: "product", product_id: UUID(1), quantity: 2 });
  });

  it("refuses any discount or charge field, even when empty-looking", () => {
    expect(waiterSubmitSchema.safeParse({ ...base(), discount: { type: "none", value: 0 } }).success).toBe(false);
    expect(waiterSubmitSchema.safeParse({ ...base(), charges: [] }).success).toBe(false);
  });

  it("requires a table for a new order and at least one item", () => {
    expect(waiterSubmitSchema.safeParse({ ...base(), tableId: null }).success).toBe(false);
    expect(waiterSubmitSchema.safeParse({ ...base(), items: [] }).success).toBe(false);
  });

  it("allows a round on an existing order without a table", () => {
    expect(waiterSubmitSchema.safeParse({ ...base(), tableId: null, orderId: UUID(102) }).success).toBe(true);
  });
});

describe("draft storage", () => {
  it("round-trips a cart and drops malformed entries", () => {
    const lines = [buildComboLine({ id: UUID(50), name: "Meal", priceMinor: 500, isVegetarian: false, isAvailable: true, imagePath: null } as PosCombo, 3, "", "k")];
    expect(parseDraft(serializeDraft(lines))).toEqual(lines);
    expect(parseDraft("not json")).toEqual([]);
    expect(parseDraft(JSON.stringify([{ key: "x" }, { key: "y", itemType: "product", name: "ok", unitPriceMinor: 1, modifiers: [], quantity: 500 }]))).toEqual([]);
    expect(parseDraft(null)).toEqual([]);
  });

  it("keys drafts per outlet and table", () => {
    expect(draftStorageKey("o1", "t1")).not.toEqual(draftStorageKey("o1", "t2"));
    expect(draftStorageKey("o1", "t1")).not.toEqual(draftStorageKey("o2", "t1"));
  });
});

describe("status presentation", () => {
  it("separates sent, POS-draft and closed order states", () => {
    expect(isSentOrderState("placed")).toBe(true);
    expect(isSentOrderState("ready")).toBe(true);
    expect(isSentOrderState("open")).toBe(false);
    expect(isPosDraftState("held")).toBe(true);
    expect(isPosDraftState("completed")).toBe(false);
  });

  it("maps kitchen item statuses to tones and counts ready quantity", () => {
    expect(kitchenTone("ready")).toBe("ready");
    expect(kitchenTone("preparing")).toBe("progress");
    expect(kitchenTone("cancelled")).toBe("cancelled");
    expect(
      readyItemCount([
        { kitchenStatus: "ready", quantity: 2 },
        { kitchenStatus: "preparing", quantity: 1 },
        { kitchenStatus: "ready", quantity: 1 },
      ]),
    ).toBe(3);
  });
});
