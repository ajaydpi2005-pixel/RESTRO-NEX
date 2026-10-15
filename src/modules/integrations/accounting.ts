import { csvField } from "@/modules/reports/csv";
import { paiseToRupees } from "@/modules/reports/format";
import type { ReportRow } from "@/modules/reports/types";

/**
 * Phase 18 — accounting CSV. A plain sales ledger for an accountant's import. It is
 * built from the same `sales-daily` report rows the reports screen shows, so the export
 * and the report always agree (the Phase 16 reconciliation covers the source).
 *
 * Money is written as plain decimal rupees with two places and no thousands separators,
 * because most accounting importers reject grouped numbers. Text cells use the same
 * formula-injection guard as the reports CSV.
 */

export const ACCOUNTING_HEADER = [
  "Date",
  "Outlet",
  "Voucher type",
  "Orders",
  "Gross sales",
  "Discounts",
  "Net sales",
  "Tax",
  "Billed total",
] as const;

const BOM = "\uFEFF";

function rupees(value: unknown): string {
  const minor = typeof value === "number" ? value : Number(value ?? 0);
  return paiseToRupees(Number.isFinite(minor) ? minor : 0).toFixed(2);
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** One ledger line per period, then a total line. The rows are complete (the route caps them). */
export function buildAccountingCsv(rows: ReportRow[], outletLabel: string): string {
  const header = ACCOUNTING_HEADER.map((h) => csvField(h, true)).join(",");
  const lines: string[] = [];
  const totals = { orders: 0, gross: 0, discount: 0, net: 0, tax: 0, billed: 0 };

  for (const row of rows) {
    const date = String(row.period_start ?? "").slice(0, 10);
    totals.orders += count(row.orders);
    totals.gross += Number(row.gross_minor ?? 0);
    totals.discount += Number(row.discount_minor ?? 0);
    totals.net += Number(row.net_sales_minor ?? 0);
    totals.tax += Number(row.tax_minor ?? 0);
    totals.billed += Number(row.billed_minor ?? 0);
    lines.push(
      [
        csvField(date, true),
        csvField(outletLabel, true),
        csvField("Sales", true),
        String(count(row.orders)),
        rupees(row.gross_minor),
        rupees(row.discount_minor),
        rupees(row.net_sales_minor),
        rupees(row.tax_minor),
        rupees(row.billed_minor),
      ].join(","),
    );
  }

  lines.push(
    [
      csvField("Total", true),
      csvField(outletLabel, true),
      csvField("Sales", true),
      String(totals.orders),
      rupees(totals.gross),
      rupees(totals.discount),
      rupees(totals.net),
      rupees(totals.tax),
      rupees(totals.billed),
    ].join(","),
  );

  return `${BOM}${[header, ...lines].join("\r\n")}\r\n`;
}
