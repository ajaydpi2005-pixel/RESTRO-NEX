import { describe, expect, it } from "vitest";
import { bucketFor, daysBetween, payablesAging } from "@/modules/purchasing/aging";
import { hasAtMostTwoDecimals, paiseToDisplay, priceVarianceMinor, rupeesToPaise } from "@/modules/purchasing/money";
import { fulfilmentPct, priceVariance, spendBySupplier } from "@/modules/purchasing/reports";
import {
  goodsReceiptSchema,
  purchaseOrderSchema,
  supplierInvoiceSchema,
  supplierPaymentSchema,
  supplierSchema,
} from "@/modules/purchasing/schemas";

const BIZ = "cccccccc-0000-4000-8000-000000000001";
const OUT = "bbbbbbbb-0000-4000-8000-000000000001";
const SUP = "dddddddd-0000-4000-8000-000000000001";
const SUP2 = "dddddddd-0000-4000-8000-000000000002";
const ING = "eeeeeeee-0000-4000-8000-000000000001";
const PO_ITEM = "ffffffff-0000-4000-8000-000000000001";
const GRI = "ffffffff-0000-4000-8000-000000000002";

describe("money helpers", () => {
  it("converts rupees to whole paise and rejects bad input", () => {
    expect(rupeesToPaise(40)).toBe(4000);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(Number.isNaN(rupeesToPaise(Number.NaN))).toBe(true);
    expect(hasAtMostTwoDecimals(12.34)).toBe(true);
    expect(hasAtMostTwoDecimals(12.345)).toBe(false);
  });

  it("displays paise without trailing zeros", () => {
    expect(paiseToDisplay(12050)).toBe("120.50");
    expect(paiseToDisplay(12000)).toBe("120");
    expect(paiseToDisplay(-250)).toBe("-2.50");
  });

  it("returns price variance with positive meaning billed above order", () => {
    expect(priceVarianceMinor(3200, 3000, 10)).toBe(2000);
    expect(priceVarianceMinor(2800, 3000, 10)).toBe(-2000);
    expect(priceVarianceMinor(4000, 4000, 3)).toBe(0);
  });
});

describe("payables ageing", () => {
  const asOf = "2026-10-12";

  it("counts whole days between due date and as-of day", () => {
    expect(daysBetween("2026-09-12", asOf)).toBe(30);
    expect(daysBetween("2026-10-12", asOf)).toBe(0);
    expect(daysBetween("2026-10-20", asOf)).toBe(-8);
  });

  it("buckets overdue days, with current covering not yet due and day zero", () => {
    expect(bucketFor(-5)).toBe("current");
    expect(bucketFor(0)).toBe("current");
    expect(bucketFor(1)).toBe("1-30");
    expect(bucketFor(30)).toBe("1-30");
    expect(bucketFor(31)).toBe("31-60");
    expect(bucketFor(61)).toBe("61-90");
    expect(bucketFor(91)).toBe("90+");
  });

  it("applies on-account payments oldest invoice first", () => {
    const invoices = [
      { id: "b", supplierId: SUP, invoiceNumber: "B", invoiceDate: "2026-08-01", dueOn: "2026-08-31", totalMinor: 30000 },
      { id: "a", supplierId: SUP, invoiceNumber: "A", invoiceDate: "2026-07-01", dueOn: "2026-07-31", totalMinor: 20000 },
      { id: "c", supplierId: SUP, invoiceNumber: "C", invoiceDate: "2026-10-01", dueOn: "2026-10-31", totalMinor: 10000 },
    ];
    // 25000 paid on account clears A fully and 5000 of B.
    const [aging] = payablesAging(invoices, [{ supplierId: SUP, amountMinor: 25000 }], asOf);
    expect(aging!.invoicedMinor).toBe(60000);
    expect(aging!.paidMinor).toBe(25000);
    expect(aging!.balanceMinor).toBe(35000);
    expect(aging!.openInvoices.map((i) => [i.id, i.openMinor])).toEqual([
      ["b", 25000],
      ["c", 10000],
    ]);
    // B is 42 days overdue (31-60), C is not yet due (current).
    expect(aging!.buckets["31-60"]).toBe(25000);
    expect(aging!.buckets.current).toBe(10000);
    expect(aging!.buckets["1-30"]).toBe(0);
  });

  it("reports an advance as a negative balance with nothing open", () => {
    const invoices = [
      { id: "a", supplierId: SUP, invoiceNumber: "A", invoiceDate: "2026-10-01", dueOn: "2026-10-31", totalMinor: 10000 },
    ];
    const [aging] = payablesAging(invoices, [{ supplierId: SUP, amountMinor: 12000 }], asOf);
    expect(aging!.balanceMinor).toBe(-2000);
    expect(aging!.openInvoices).toEqual([]);
  });

  it("keeps suppliers separate and sorts the largest balance first", () => {
    const invoices = [
      { id: "a", supplierId: SUP, invoiceNumber: "A", invoiceDate: "2026-10-01", dueOn: "2026-10-31", totalMinor: 5000 },
      { id: "b", supplierId: SUP2, invoiceNumber: "B", invoiceDate: "2026-10-01", dueOn: "2026-10-31", totalMinor: 9000 },
    ];
    const result = payablesAging(invoices, [{ supplierId: SUP2, amountMinor: 1000 }], asOf);
    expect(result.map((r) => r.supplierId)).toEqual([SUP2, SUP]);
    expect(result[0]!.balanceMinor).toBe(8000);
    expect(result[1]!.balanceMinor).toBe(5000);
  });
});

describe("purchase reports", () => {
  it("sums spend per supplier, largest first", () => {
    const rows = spendBySupplier([
      { supplierId: SUP, supplierName: "Fresh", subtotalMinor: 50000, taxMinor: 2500, totalMinor: 52500 },
      { supplierId: SUP2, supplierName: "Pack", subtotalMinor: 9000, taxMinor: 0, totalMinor: 9000 },
      { supplierId: SUP, supplierName: "Fresh", subtotalMinor: 14000, taxMinor: 0, totalMinor: 14000 },
    ]);
    expect(rows[0]).toMatchObject({ supplierId: SUP, invoices: 2, subtotalMinor: 64000, taxMinor: 2500, totalMinor: 66500 });
    expect(rows[1]).toMatchObject({ supplierId: SUP2, invoices: 1, totalMinor: 9000 });
  });

  it("lists only lines billed off their order price, largest variance first", () => {
    const result = priceVariance([
      { ingredientName: "Flour", supplierName: "Fresh", unit: "kg", qty: 10, orderedUnitCost: 3000, billedUnitCost: 3200 },
      { ingredientName: "Tomato", supplierName: "Fresh", unit: "kg", qty: 3, orderedUnitCost: 4000, billedUnitCost: 4000 },
      { ingredientName: "Cups", supplierName: "Pack", unit: "dz", qty: 2, orderedUnitCost: 6000, billedUnitCost: 5500 },
    ]);
    expect(result.rows.map((r) => r.ingredientName)).toEqual(["Flour", "Cups"]);
    expect(result.rows[0]!.varianceMinor).toBe(2000);
    expect(result.rows[1]!.varianceMinor).toBe(-1000);
    expect(result.netMinor).toBe(1000);
    expect(result.overchargeMinor).toBe(2000);
  });

  it("computes fulfilment as a share of ordered quantity", () => {
    expect(fulfilmentPct(5000, 3000)).toBe(60);
    expect(fulfilmentPct(0, 0)).toBeNull();
    expect(fulfilmentPct(10, 12)).toBe(100);
  });
});

describe("purchasing schemas", () => {
  const supplierBase = { businessId: BIZ, name: "Fresh Farms", paymentTermsDays: "30", status: "active" };

  it("accepts a supplier with a valid GSTIN and normalises it", () => {
    const parsed = supplierSchema.parse({ ...supplierBase, gstin: "29abcde1234f1z5" });
    expect(parsed.gstin).toBe("29ABCDE1234F1Z5");
    expect(parsed.paymentTermsDays).toBe(30);
  });

  it("refuses a malformed GSTIN, email or negative terms", () => {
    expect(supplierSchema.safeParse({ ...supplierBase, gstin: "NOTVALID" }).success).toBe(false);
    expect(supplierSchema.safeParse({ ...supplierBase, email: "not-an-email" }).success).toBe(false);
    expect(supplierSchema.safeParse({ ...supplierBase, paymentTermsDays: "-1" }).success).toBe(false);
  });

  const poLine = { ingredientId: ING, unit: "kg", qty: "5", unitCostRupees: "40" };

  it("requires at least one purchase order line with a positive quantity", () => {
    const base = { businessId: BIZ, outletId: OUT, supplierId: SUP };
    expect(purchaseOrderSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(purchaseOrderSchema.safeParse({ ...base, lines: [{ ...poLine, qty: "0" }] }).success).toBe(false);
    expect(purchaseOrderSchema.safeParse({ ...base, lines: [poLine] }).success).toBe(true);
  });

  it("refuses receipts with no quantity and invoices billed before they are dated", () => {
    const base = { businessId: BIZ, outletId: OUT, purchaseOrderId: PO_ITEM, clientRef: "grn-ref-0001" };
    expect(goodsReceiptSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(
      goodsReceiptSchema.safeParse({ ...base, lines: [{ poItemId: PO_ITEM, qty: "2", unit: "kg" }] }).success,
    ).toBe(true);

    const invoice = {
      businessId: BIZ,
      outletId: OUT,
      supplierId: SUP,
      invoiceNumber: "FF-1",
      invoiceDate: "2026-10-12",
      dueOn: "2026-10-01",
      taxRupees: 0,
      clientRef: "inv-ref-0001",
      lines: [{ goodsReceiptItemId: GRI, unitCostRupees: 40 }],
    };
    expect(supplierInvoiceSchema.safeParse(invoice).success).toBe(false);
    expect(supplierInvoiceSchema.safeParse({ ...invoice, dueOn: "2026-11-11" }).success).toBe(true);
  });

  it("refuses payments that are zero, negative or have too many decimals", () => {
    const base = { businessId: BIZ, supplierId: SUP, method: "cash", clientRef: "pay-ref-0001" };
    expect(supplierPaymentSchema.safeParse({ ...base, amountRupees: 0 }).success).toBe(false);
    expect(supplierPaymentSchema.safeParse({ ...base, amountRupees: -5 }).success).toBe(false);
    expect(supplierPaymentSchema.safeParse({ ...base, amountRupees: 10.555 }).success).toBe(false);
    expect(supplierPaymentSchema.safeParse({ ...base, amountRupees: 465 }).success).toBe(true);
  });
});
