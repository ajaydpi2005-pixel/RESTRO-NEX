import { describe, expect, it } from "vitest";
import {
  cartSignature,
  cartSubtotalMinor,
  orderingBlock,
  unitPriceMinor,
  validateSelection,
  type CartLine,
} from "./cart";
import { formatRupees, randomUrlSafe } from "./client-random";
import { checkoutSchema } from "./schemas";
import {
  clientFingerprint,
  isSameOriginRequest,
  randomToken,
  readJsonBody,
  sha256Hex,
} from "./security";
import type { OrderingSettings, PublicMenuItem } from "./types";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const CLIENT_REF = "abcdefghij123456";
const SECRET = "A".repeat(43);

const settings: OrderingSettings = {
  online_enabled: true,
  takeaway_enabled: true,
  delivery_enabled: true,
  qr_enabled: true,
  accepting_orders: true,
  auto_accept: false,
  min_order_minor: 20000,
  delivery_fee_minor: 3000,
  packaging_fee_minor: 1000,
  prep_minutes: 20,
};

const item: PublicMenuItem = {
  id: UUID,
  item_type: "product",
  name: "Dosa",
  description: null,
  is_vegetarian: true,
  price_minor: 12000,
  variants: [
    { id: UUID2, name: "Regular", price_minor: 12000 },
    { id: "33333333-3333-4333-8333-333333333333", name: "Large", price_minor: 16000 },
  ],
  modifier_groups: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Extras",
      min_selected: 1,
      max_selected: 2,
      modifiers: [
        { id: "55555555-5555-4555-8555-555555555555", name: "Cheese", price_minor: 2000 },
        { id: "66666666-6666-4666-8666-666666666666", name: "Egg", price_minor: 1500 },
        { id: "77777777-7777-4777-8777-777777777777", name: "Ghee", price_minor: 500 },
      ],
    },
  ],
};

describe("cart: selection rules", () => {
  it("requires a variant when the item has variants", () => {
    expect(
      validateSelection({
        item,
        variantId: null,
        selectedModifierIds: ["55555555-5555-4555-8555-555555555555"],
        quantity: 1,
      }),
    ).toMatch(/size or variant/);
  });

  it("enforces the modifier minimum and maximum per group", () => {
    const none = validateSelection({
      item,
      variantId: UUID2,
      selectedModifierIds: [],
      quantity: 1,
    });
    expect(none).toMatch(/at least 1 option for Extras/);
    const tooMany = validateSelection({
      item,
      variantId: UUID2,
      selectedModifierIds: [
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
        "77777777-7777-4777-8777-777777777777",
      ],
      quantity: 1,
    });
    expect(tooMany).toMatch(/at most 2 options/);
  });

  it("accepts a valid selection and rejects bad quantities", () => {
    expect(
      validateSelection({
        item,
        variantId: UUID2,
        selectedModifierIds: ["55555555-5555-4555-8555-555555555555"],
        quantity: 2,
      }),
    ).toBeNull();
    expect(
      validateSelection({
        item,
        variantId: UUID2,
        selectedModifierIds: ["55555555-5555-4555-8555-555555555555"],
        quantity: 0,
      }),
    ).toMatch(/between 1 and 99/);
    expect(
      validateSelection({
        item,
        variantId: UUID2,
        selectedModifierIds: ["55555555-5555-4555-8555-555555555555"],
        quantity: 1.5,
      }),
    ).toMatch(/between 1 and 99/);
  });

  it("computes the unit price from the variant plus options (display only)", () => {
    expect(
      unitPriceMinor(item, item.variants[1]!, [{ price_minor: 2000 }, { price_minor: 500 }]),
    ).toBe(18500);
    expect(unitPriceMinor({ price_minor: 500 }, null, [])).toBe(500);
  });
});

describe("cart: signature for safe retries", () => {
  const line = (over: Partial<CartLine> = {}): CartLine => ({
    lineId: "x",
    kind: "product",
    itemId: UUID,
    itemName: "Dosa",
    variant: null,
    modifiers: [],
    quantity: 1,
    notes: null,
    unitMinor: 12000,
    ...over,
  });

  it("is stable for the same cart and form", () => {
    expect(cartSignature([line()], { name: "A" })).toBe(
      cartSignature([line({ lineId: "different" })], { name: "A" }),
    );
  });

  it("changes when quantity, notes, options or form data change", () => {
    const base = cartSignature([line()], { name: "A" });
    expect(cartSignature([line({ quantity: 2 })], { name: "A" })).not.toBe(base);
    expect(cartSignature([line({ notes: "no onion" })], { name: "A" })).not.toBe(base);
    expect(
      cartSignature([line({ modifiers: [{ id: "m", name: "Egg", price_minor: 1 }] })], {
        name: "A",
      }),
    ).not.toBe(base);
    expect(cartSignature([line()], { name: "B" })).not.toBe(base);
  });

  it("subtotal sums unit × quantity", () => {
    expect(cartSubtotalMinor([line({ quantity: 2 }), line({ unitMinor: 500, quantity: 3 })])).toBe(
      25500,
    );
  });
});

describe("cart: channel availability", () => {
  it("blocks when the outlet is paused", () => {
    expect(orderingBlock({ ...settings, accepting_orders: false }, "online", "takeaway")).toMatch(
      /not taking orders/,
    );
  });

  it("blocks disabled channels and types", () => {
    expect(orderingBlock({ ...settings, online_enabled: false }, "online", "takeaway")).toMatch(
      /Online ordering/,
    );
    expect(orderingBlock({ ...settings, delivery_enabled: false }, "online", "delivery")).toMatch(
      /Delivery is not/,
    );
    expect(orderingBlock({ ...settings, qr_enabled: false }, "qr", null)).toMatch(/Table ordering/);
  });

  it("allows an open channel", () => {
    expect(orderingBlock(settings, "online", "delivery")).toBeNull();
    expect(orderingBlock(settings, "qr", null)).toBeNull();
  });
});

describe("client helpers", () => {
  it("formats paise as Indian rupee text", () => {
    expect(formatRupees(123450)).toBe("1,234.50");
    expect(formatRupees(0)).toBe("0.00");
  });

  it("makes url-safe tokens of the expected length", () => {
    const token = randomUrlSafe(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBe(43);
    expect(randomUrlSafe(32)).not.toBe(token);
  });
});

describe("schemas: checkout", () => {
  const base = {
    channel: "online" as const,
    businessSlug: "spice-house",
    outletSlug: "main",
    clientRef: CLIENT_REF,
    trackingSecret: SECRET,
    orderType: "takeaway" as const,
    customerPhone: "9876543210",
    items: [
      {
        kind: "product" as const,
        id: UUID,
        variantId: UUID2,
        quantity: 2,
        modifiers: [{ id: UUID, quantity: 1 }],
      },
    ],
  };

  it("accepts a valid online takeaway", () => {
    expect(checkoutSchema.safeParse(base).success).toBe(true);
  });

  it("strips client-sent prices and totals", () => {
    const parsed = checkoutSchema.parse({
      ...base,
      total_minor: 1,
      items: [{ ...base.items[0], price_minor: 1, line_total_minor: 1 }],
    });
    expect(parsed).not.toHaveProperty("total_minor");
    expect(parsed.items[0]).not.toHaveProperty("price_minor");
    expect(parsed.items[0]).not.toHaveProperty("line_total_minor");
  });

  it("requires a phone number and an address for delivery", () => {
    expect(checkoutSchema.safeParse({ ...base, customerPhone: undefined }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, orderType: "delivery" }).success).toBe(false);
    expect(
      checkoutSchema.safeParse({ ...base, orderType: "delivery", deliveryAddress: "12 Lane" })
        .success,
    ).toBe(true);
  });

  it("requires a QR token for table orders and does not need a phone", () => {
    const qr = {
      channel: "qr" as const,
      qrToken: "a".repeat(32),
      clientRef: CLIENT_REF,
      trackingSecret: SECRET,
      items: base.items,
    };
    expect(checkoutSchema.safeParse(qr).success).toBe(true);
    expect(checkoutSchema.safeParse({ ...qr, qrToken: undefined }).success).toBe(false);
  });

  it("rejects malformed keys and secrets", () => {
    expect(checkoutSchema.safeParse({ ...base, clientRef: "short" }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, trackingSecret: "too-short" }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  });
});

describe("security helpers", () => {
  it("hashes deterministically without storing the input", () => {
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toContain("abc");
  });

  it("issues random url-safe tokens", () => {
    const a = randomToken(24);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(randomToken(24)).not.toBe(a);
  });

  it("never stores the raw IP in the rate-limit fingerprint", () => {
    const fp = clientFingerprint(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    expect(fp).toHaveLength(32);
    expect(fp).not.toContain("203.0.113.9");
    expect(fp).toBe(clientFingerprint(new Headers({ "x-forwarded-for": "203.0.113.9" })));
  });

  it("refuses a mismatched Origin and allows a same-origin or header-less request", () => {
    const same = new Request("https://shop.example/api/public/checkout", {
      method: "POST",
      headers: { origin: "https://shop.example", host: "shop.example" },
    });
    const other = new Request("https://shop.example/api/public/checkout", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "shop.example" },
    });
    const none = new Request("https://shop.example/api/public/checkout", {
      method: "POST",
      headers: { host: "shop.example" },
    });
    expect(isSameOriginRequest(same)).toBe(true);
    expect(isSameOriginRequest(other)).toBe(false);
    expect(isSameOriginRequest(none)).toBe(true);
  });

  it("refuses non-JSON, oversize and malformed bodies", async () => {
    const form = new Request("https://x.test/", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect((await readJsonBody(form)).ok).toBe(false);

    const bad = new Request("https://x.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    const badResult = await readJsonBody(bad);
    expect(badResult).toMatchObject({ ok: false, status: 400 });

    const big = new Request("https://x.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(40),
    });
    expect(await readJsonBody(big, 10)).toMatchObject({ ok: false, status: 413 });

    const good = new Request("https://x.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(await readJsonBody(good)).toEqual({ ok: true, value: { a: 1 } });
  });
});
