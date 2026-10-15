/**
 * Phase 16 — the shapes that cross from the database to the pages and the exports.
 */

export type ReportRow = Record<string, unknown>;

/** What a report function returns: `total` counts the rows before paging; `summary` covers all rows. */
export interface ReportPayload {
  total: number;
  rows: ReportRow[];
  summary: Record<string, unknown>;
}

/** Context printed on the exports, so a file is readable on its own. */
export interface ExportMeta {
  businessName: string;
  outletLabel: string;
  from: string;
  to: string;
  /** Empty when the report has no date range. */
  dateLabel: string;
  search: string;
  /** Generated time, already formatted in Asia/Kolkata. */
  generatedAt: string;
  /** The basis note from the registry. */
  basis: string;
}
