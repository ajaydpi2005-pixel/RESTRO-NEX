/**
 * Phase 14 — purchase reports. Pure functions over rows the queries load, so
 * every number on the reports page can be tested without a database.
 */

export interface InvoiceForSpend {
  supplierId: string;
  supplierName: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface SpendRow {
  supplierId: string;
  supplierName: string;
  invoices: number;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/** Spend by supplier, largest first. Totals are sums of stored invoice totals. */
export function spendBySupplier(invoices: readonly InvoiceForSpend[]): SpendRow[] {
  const map = new Map<string, SpendRow>();
  for (const inv of invoices) {
    const row = map.get(inv.supplierId) ?? {
      supplierId: inv.supplierId,
      supplierName: inv.supplierName,
      invoices: 0,
      subtotalMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
    };
    row.invoices += 1;
    row.subtotalMinor += inv.subtotalMinor;
    row.taxMinor += inv.taxMinor;
    row.totalMinor += inv.totalMinor;
    map.set(inv.supplierId, row);
  }
  return [...map.values()].sort((a, b) => b.totalMinor - a.totalMinor || a.supplierName.localeCompare(b.supplierName));
}

export interface VarianceLine {
  ingredientName: string;
  supplierName: string;
  unit: string;
  qty: number;
  orderedUnitCost: number;
  billedUnitCost: number;
}

export interface VarianceRow extends VarianceLine {
  varianceMinor: number;
}

/** Billed-vs-ordered price variance per billed line. Positive = paid more than ordered. */
export function priceVariance(lines: readonly VarianceLine[]): {
  rows: VarianceRow[];
  netMinor: number;
  overchargeMinor: number;
} {
  const rows = lines
    .map((l) => ({
      ...l,
      varianceMinor: Math.round((l.billedUnitCost - l.orderedUnitCost) * l.qty * 100) / 100,
    }))
    .filter((r) => r.varianceMinor !== 0)
    .sort((a, b) => Math.abs(b.varianceMinor) - Math.abs(a.varianceMinor));
  const netMinor = rows.reduce((sum, r) => sum + r.varianceMinor, 0);
  const overchargeMinor = rows.filter((r) => r.varianceMinor > 0).reduce((sum, r) => sum + r.varianceMinor, 0);
  return {
    rows,
    netMinor: Math.round(netMinor * 100) / 100,
    overchargeMinor: Math.round(overchargeMinor * 100) / 100,
  };
}

/** Share of ordered quantity received, 0–100 (one decimal), or null when nothing was ordered. */
export function fulfilmentPct(orderedBase: number, receivedBase: number): number | null {
  if (orderedBase <= 0) return null;
  return Math.min(100, Math.round((receivedBase / orderedBase) * 1000) / 10);
}

export const PO_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  partially_received: "Part received",
  received: "Received",
  cancelled: "Cancelled",
};
