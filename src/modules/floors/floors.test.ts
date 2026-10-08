import { describe, expect, it } from "vitest";
import {
  deleteFloorSchema,
  mergeTablesSchema,
  reserveTableSchema,
  saveFloorSchema,
  saveSectionSchema,
  saveTableSchema,
  splitOrderSchema,
  transferTableSchema,
} from "@/modules/floors/schemas";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("floor configuration schemas", () => {
  it("accepts a new floor (empty floorId = create)", () => {
    const parsed = saveFloorSchema.safeParse({
      businessId: uuid(1),
      outletId: uuid(2),
      floorId: "",
      name: "Level 1",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects blank or oversized floor names", () => {
    expect(
      saveFloorSchema.safeParse({ businessId: uuid(1), outletId: uuid(2), floorId: "", name: "   " }).success,
    ).toBe(false);
    expect(
      saveFloorSchema.safeParse({ businessId: uuid(1), outletId: uuid(2), floorId: "", name: "x".repeat(61) })
        .success,
    ).toBe(false);
  });

  it("requires a valid floor id when deleting", () => {
    expect(deleteFloorSchema.safeParse({ businessId: uuid(1), floorId: "nope" }).success).toBe(false);
    expect(deleteFloorSchema.safeParse({ businessId: uuid(1), floorId: uuid(3) }).success).toBe(true);
  });

  it("requires an explicit floor for sections", () => {
    const parsed = saveSectionSchema.safeParse({
      businessId: uuid(1),
      outletId: uuid(2),
      sectionId: "",
      floorId: uuid(3),
      name: "Window",
    });
    expect(parsed.success).toBe(true);
    const missing = saveSectionSchema.safeParse({
      businessId: uuid(1),
      outletId: uuid(2),
      sectionId: "",
      name: "Window",
    });
    expect(missing.success).toBe(false);
  });

  it("coerces capacity strings and enforces 1..50 seats", () => {
    const ok = saveTableSchema.safeParse({
      businessId: uuid(1),
      outletId: uuid(2),
      tableId: "",
      sectionId: uuid(3),
      label: "T1",
      capacity: "4",
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.capacity).toBe(4);

    for (const capacity of ["0", "51", "-2", "abc", "2.5"]) {
      expect(
        saveTableSchema.safeParse({
          businessId: uuid(1),
          outletId: uuid(2),
          tableId: "",
          sectionId: uuid(3),
          label: "T1",
          capacity,
        }).success,
      ).toBe(false);
    }
  });

  it("caps table labels at 20 characters and reservation notes at 120", () => {
    expect(
      saveTableSchema.safeParse({
        businessId: uuid(1),
        outletId: uuid(2),
        tableId: "",
        sectionId: uuid(3),
        label: "x".repeat(21),
        capacity: 2,
      }).success,
    ).toBe(false);
    expect(
      reserveTableSchema.safeParse({ businessId: uuid(1), tableId: uuid(2), note: "x".repeat(121) }).success,
    ).toBe(false);
  });
});

describe("dine-in operation schemas", () => {
  it("requires distinct orders for a merge", () => {
    const parsed = mergeTablesSchema.safeParse({
      businessId: uuid(1),
      keepOrderId: uuid(2),
      mergeOrderId: uuid(3),
    });
    expect(parsed.success).toBe(true);
  });

  it("requires an order and a target table for transfers", () => {
    expect(transferTableSchema.safeParse({ businessId: uuid(1), orderId: uuid(2) }).success).toBe(false);
    expect(
      transferTableSchema.safeParse({ businessId: uuid(1), orderId: uuid(2), toTableId: uuid(3) }).success,
    ).toBe(true);
  });

  it("requires at least one item to split", () => {
    expect(
      splitOrderSchema.safeParse({ businessId: uuid(1), orderId: uuid(2), itemIds: [], toTableId: uuid(3) })
        .success,
    ).toBe(false);
    expect(
      splitOrderSchema.safeParse({
        businessId: uuid(1),
        orderId: uuid(2),
        itemIds: [uuid(4)],
        toTableId: uuid(3),
      }).success,
    ).toBe(true);
  });
});
