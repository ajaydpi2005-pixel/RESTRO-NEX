/**
 * Phase 14 — payables ageing. Supplier payments are on account (they are not
 * tied to an invoice), so they are applied oldest-invoice-first (FIFO) to find
 * what is still open. Pure: no clock, no database. The caller passes `asOf`.
 */

export interface AgingInvoice {
  id: string;
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueOn: string;
  totalMinor: number;
}

export interface AgingPayment {
  supplierId: string;
  amountMinor: number;
}

export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export const AGING_BUCKETS: AgingBucket[] = ["current", "1-30", "31-60", "61-90", "90+"];

export interface OpenInvoice extends AgingInvoice {
  openMinor: number;
  daysOverdue: number;
  bucket: AgingBucket;
}

export interface SupplierAging {
  supplierId: string;
  invoicedMinor: number;
  paidMinor: number;
  /** Positive = owed to the supplier; negative = advance paid (credit). */
  balanceMinor: number;
  buckets: Record<AgingBucket, number>;
  openInvoices: OpenInvoice[];
}

/** Whole days from `dueOn` to `asOf` (positive = overdue). Both are YYYY-MM-DD. */
export function daysBetween(dueOn: string, asOf: string): number {
  const ms = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function bucketFor(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

function emptyBuckets(): Record<AgingBucket, number> {
  return { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
}

export function payablesAging(
  invoices: readonly AgingInvoice[],
  payments: readonly AgingPayment[],
  asOf: string,
): SupplierAging[] {
  const supplierIds = new Set([...invoices.map((i) => i.supplierId), ...payments.map((p) => p.supplierId)]);
  const result: SupplierAging[] = [];

  for (const supplierId of supplierIds) {
    const bills = invoices
      .filter((i) => i.supplierId === supplierId)
      .slice()
      .sort(
        (a, b) =>
          a.invoiceDate.localeCompare(b.invoiceDate) ||
          a.invoiceNumber.localeCompare(b.invoiceNumber) ||
          a.id.localeCompare(b.id),
      );
    const invoicedMinor = bills.reduce((sum, b) => sum + b.totalMinor, 0);
    const paidMinor = payments.filter((p) => p.supplierId === supplierId).reduce((sum, p) => sum + p.amountMinor, 0);

    // FIFO: payments clear the oldest invoices first.
    let remainingPaid = paidMinor;
    const buckets = emptyBuckets();
    const openInvoices: OpenInvoice[] = [];
    for (const bill of bills) {
      const applied = Math.min(bill.totalMinor, Math.max(remainingPaid, 0));
      remainingPaid -= applied;
      const openMinor = bill.totalMinor - applied;
      if (openMinor <= 0) continue;
      const daysOverdue = daysBetween(bill.dueOn, asOf);
      const bucket = bucketFor(daysOverdue);
      buckets[bucket] += openMinor;
      openInvoices.push({ ...bill, openMinor, daysOverdue, bucket });
    }

    result.push({
      supplierId,
      invoicedMinor,
      paidMinor,
      balanceMinor: invoicedMinor - paidMinor,
      buckets,
      openInvoices,
    });
  }

  return result.sort((a, b) => b.balanceMinor - a.balanceMinor || a.supplierId.localeCompare(b.supplierId));
}
