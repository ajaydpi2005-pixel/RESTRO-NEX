import { describe, expect, it } from "vitest";
import {
  bumpableItems,
  buildTickets,
  formatElapsed,
  minStatus,
  stationCounts,
  ticketsByColumn,
  timerTone,
  type KitchenItemRow,
} from "./board-logic";
import {
  ALL_FILTER,
  isActiveKitchenStatus,
  LATE_AFTER_MS,
  NEXT_TARGET,
  UNROUTED_FILTER,
  WARN_AFTER_MS,
  type KitchenStatus,
} from "./constants";
import {
  advanceItemSchema,
  advanceTicketSchema,
  routesPayloadSchema,
  stationsPayloadSchema,
} from "./schemas";

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";
const HOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BAR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RETIRED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ITEM_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OUTLET = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let counter = 0;
function item(overrides: Partial<KitchenItemRow> & { order_id: string }): KitchenItemRow {
  counter += 1;
  return {
    id: `item-${counter}`,
    business_id: "biz",
    outlet_id: "out",
    order_number: overrides.order_id === ORDER_A ? 7 : 8,
    order_type: "dine_in",
    table_label: "T1",
    station_id: HOT,
    item_name: `Dish ${counter}`,
    quantity: 1,
    item_notes: null,
    modifiers: [],
    kitchen_status: "new",
    kitchen_status_at: "2026-10-09T10:00:00.000Z",
    sent_at: "2026-10-09T10:00:00.000Z",
    priority: false,
    position: counter,
    updated_at: "2026-10-09T10:00:00.000Z",
    ...overrides,
  };
}

const ACTIVE = new Set([HOT, BAR]);

describe("timers", () => {
  it("are calm, then amber at 8 minutes, then red at 15", () => {
    expect(timerTone(0)).toBe("calm");
    expect(timerTone(WARN_AFTER_MS - 1)).toBe("calm");
    expect(timerTone(WARN_AFTER_MS)).toBe("warn");
    expect(timerTone(LATE_AFTER_MS - 1)).toBe("warn");
    expect(timerTone(LATE_AFTER_MS)).toBe("late");
  });

  it("formats m:ss and h:mm:ss, clamping negatives", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_900)).toBe("1:05");
    expect(formatElapsed(15 * 60_000)).toBe("15:00");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});

describe("status arithmetic", () => {
  it("only new, accepted, preparing and ready keep an item on the board", () => {
    for (const status of ["new", "accepted", "preparing", "ready"]) {
      expect(isActiveKitchenStatus(status)).toBe(true);
    }
    for (const status of ["pending", "completed", "cancelled", ""]) {
      expect(isActiveKitchenStatus(status)).toBe(false);
    }
  });

  it("a ticket is only as far along as its least-advanced item", () => {
    expect(minStatus(["ready", "preparing", "ready"])).toBe("preparing");
    expect(minStatus(["ready", "ready"])).toBe("ready");
    expect(minStatus(["accepted", "new"])).toBe("new");
  });

  it("walks new → accepted → preparing → ready → completed", () => {
    expect(NEXT_TARGET.new).toBe("accepted");
    expect(NEXT_TARGET.accepted).toBe("preparing");
    expect(NEXT_TARGET.preparing).toBe("ready");
    expect(NEXT_TARGET.ready).toBe("completed");
  });
});

describe("station tickets", () => {
  it("groups items by order and station: one ticket per lane", () => {
    const items = [
      item({ order_id: ORDER_A, station_id: HOT }),
      item({ order_id: ORDER_A, station_id: HOT }),
      item({ order_id: ORDER_A, station_id: BAR }),
    ];
    const tickets = buildTickets(items, ACTIVE);
    expect(tickets).toHaveLength(2);
    expect(tickets.map((t) => t.items.length).sort()).toEqual([1, 2]);
  });

  it("routes an order's items to separate station tickets, not one mixed ticket", () => {
    const tickets = buildTickets(
      [item({ order_id: ORDER_A, station_id: HOT }), item({ order_id: ORDER_A, station_id: BAR })],
      ACTIVE,
    );
    expect(new Set(tickets.map((t) => t.stationId))).toEqual(new Set([HOT, BAR]));
  });

  it("items on an inactive or deleted station fall back to Unrouted", () => {
    const tickets = buildTickets(
      [item({ order_id: ORDER_A, station_id: RETIRED }), item({ order_id: ORDER_B, station_id: null })],
      ACTIVE,
    );
    expect(tickets.every((t) => t.stationId === null)).toBe(true);
    expect(buildTickets(tickets.flatMap((t) => t.items), ACTIVE, UNROUTED_FILTER)).toHaveLength(2);
  });

  it("a station filter shows only that station's lanes", () => {
    const items = [
      item({ order_id: ORDER_A, station_id: HOT }),
      item({ order_id: ORDER_A, station_id: BAR }),
      item({ order_id: ORDER_B, station_id: null }),
    ];
    expect(buildTickets(items, ACTIVE, HOT)).toHaveLength(1);
    expect(buildTickets(items, ACTIVE, BAR)).toHaveLength(1);
    expect(buildTickets(items, ACTIVE, UNROUTED_FILTER)).toHaveLength(1);
    expect(buildTickets(items, ACTIVE, ALL_FILTER)).toHaveLength(3);
  });

  it("the column is the least-advanced status in the lane", () => {
    const tickets = buildTickets(
      [
        item({ order_id: ORDER_A, station_id: HOT, kitchen_status: "ready" }),
        item({ order_id: ORDER_A, station_id: HOT, kitchen_status: "preparing" }),
      ],
      ACTIVE,
    );
    const columns = ticketsByColumn(tickets);
    expect(columns.preparing).toHaveLength(1);
    expect(columns.ready).toHaveLength(0);
  });

  it("bump only moves the items still at the ticket's status", () => {
    const [ticket] = buildTickets(
      [
        item({ order_id: ORDER_A, station_id: HOT, kitchen_status: "ready" }),
        item({ order_id: ORDER_A, station_id: HOT, kitchen_status: "preparing" }),
        item({ order_id: ORDER_A, station_id: HOT, kitchen_status: "preparing" }),
      ],
      ACTIVE,
    );
    expect(ticket!.status).toBe<KitchenStatus>("preparing");
    expect(bumpableItems(ticket!)).toHaveLength(2);
  });

  it("priority tickets come first, then the oldest send time", () => {
    const tickets = buildTickets(
      [
        item({ order_id: ORDER_A, station_id: HOT, sent_at: "2026-10-09T10:05:00.000Z" }),
        item({ order_id: ORDER_B, station_id: HOT, sent_at: "2026-10-09T10:09:00.000Z", priority: true }),
        item({ order_id: ORDER_A, station_id: BAR, sent_at: "2026-10-09T10:01:00.000Z" }),
      ],
      ACTIVE,
    );
    expect(tickets[0]!.orderId).toBe(ORDER_B);
    expect(tickets[1]!.stationId).toBe(BAR);
  });

  it("the order timer runs from the earliest item sent", () => {
    const [ticket] = buildTickets(
      [
        item({ order_id: ORDER_A, station_id: HOT, sent_at: "2026-10-09T10:07:00.000Z" }),
        item({ order_id: ORDER_A, station_id: HOT, sent_at: "2026-10-09T10:02:00.000Z" }),
      ],
      ACTIVE,
    );
    expect(ticket!.sentAt).toBe("2026-10-09T10:02:00.000Z");
  });

  it("station tab counts add up to the board", () => {
    const items = [
      item({ order_id: ORDER_A, station_id: HOT }),
      item({ order_id: ORDER_A, station_id: BAR }),
      item({ order_id: ORDER_B, station_id: RETIRED }),
    ];
    const counts = stationCounts(items, ACTIVE);
    expect(counts.get(ALL_FILTER)).toBe(3);
    expect(counts.get(HOT)).toBe(1);
    expect(counts.get(BAR)).toBe(1);
    expect(counts.get(UNROUTED_FILTER)).toBe(1);
  });
});

describe("kitchen payload validation", () => {
  it("accepts only the item moves the lifecycle allows, by shape", () => {
    expect(advanceItemSchema.safeParse({ outletId: OUTLET, itemId: ITEM_UUID, from: "new", to: "accepted" }).success).toBe(true);
    expect(advanceItemSchema.safeParse({ outletId: OUTLET, itemId: ITEM_UUID, from: "new", to: "cancelled" }).success).toBe(false);
    expect(advanceItemSchema.safeParse({ outletId: "not-a-uuid", itemId: ITEM_UUID, from: "new", to: "accepted" }).success).toBe(false);
  });

  it("allows a null station for the unrouted lane on ticket moves", () => {
    expect(
      advanceTicketSchema.safeParse({ outletId: OUTLET, orderId: ORDER_A, stationId: null, from: "new", to: "accepted" }).success,
    ).toBe(true);
  });

  it("rejects duplicate station names regardless of case", () => {
    const result = stationsPayloadSchema.safeParse({
      outletId: OUTLET,
      stations: [{ name: "Hot kitchen", description: null }, { name: " hot KITCHEN ", description: null }],
    });
    expect(result.success).toBe(false);
  });

  it("trims names and treats blank descriptions as none", () => {
    const result = stationsPayloadSchema.parse({
      outletId: OUTLET,
      stations: [{ name: "  Bar  ", description: "   " }],
    });
    expect(result.stations[0]).toEqual({ name: "Bar", description: null });
  });

  it("caps stations at 20 and names at 60 characters", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `S${i}`, description: null }));
    expect(stationsPayloadSchema.safeParse({ outletId: OUTLET, stations: many }).success).toBe(false);
    expect(
      stationsPayloadSchema.safeParse({ outletId: OUTLET, stations: [{ name: "x".repeat(61), description: null }] }).success,
    ).toBe(false);
  });

  it("routes only target categories, items or combos", () => {
    const base = { outletId: OUTLET, routes: [{ targetType: "category", targetId: ORDER_A, stationId: HOT }] };
    expect(routesPayloadSchema.safeParse(base).success).toBe(true);
    expect(
      routesPayloadSchema.safeParse({ outletId: OUTLET, routes: [{ targetType: "table", targetId: ORDER_A, stationId: HOT }] })
        .success,
    ).toBe(false);
  });
});
