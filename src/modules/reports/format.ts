import type { ColumnType, ReportColumn } from "@/modules/reports/registry";

/**
 * Phase 16 — one formatter for every report output. Money is stored in paise and shown in
 * rupees to two decimals. The three styles differ only in how they render:
 *   ui    — ₹ and Indian digit grouping, for the screen.
 *   csv   — plain numbers with no grouping, so spreadsheets can parse them.
 *   pdf   — "Rs." instead of ₹, because the PDF standard fonts have no ₹ glyph.
 */

export type FormatStyle = "ui" | "csv" | "pdf";

const IST = "Asia/Kolkata";

/** Paise to rupees, rounded to the nearest paisa. */
export function paiseToRupees(minor: number): number {
  return Math.round(minor) / 100;
}

function groupedNumber(value: number, digits: number): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** The money string for one style. `minor` is paise. */
export function formatMoney(minor: number, style: FormatStyle): string {
  const rupees = paiseToRupees(minor);
  if (style === "csv") return rupees.toFixed(2);
  if (style === "pdf") return `Rs. ${groupedNumber(rupees, 2)}`;
  return `₹${groupedNumber(rupees, 2)}`;
}

/** Unit cost is paise per base unit, shown as rupees to four decimals. */
export function formatUnitCost(paisePerUnit: number, style: FormatStyle): string {
  const rupees = Math.round(paisePerUnit * 100) / 10000;
  const fixed = rupees.toFixed(4);
  if (style === "csv") return fixed;
  if (style === "pdf") return `Rs. ${fixed}`;
  return `₹${fixed}`;
}

export function formatInt(value: number, style: FormatStyle): string {
  const rounded = Math.round(value);
  return style === "csv" ? String(rounded) : groupedNumber(rounded, 0);
}

/** Quantities keep up to three decimals and drop trailing zeros. */
export function formatQty(value: number, style: FormatStyle): string {
  if (style === "csv") return String(Math.round(value * 1000) / 1000);
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(value);
}

export function formatPercent(value: number, style: FormatStyle): string {
  const fixed = (Math.round(value * 100) / 100).toFixed(2);
  return style === "csv" ? fixed : `${fixed}%`;
}

const DATE_LONG = new Intl.DateTimeFormat("en-IN", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const MONTH_YEAR = new Intl.DateTimeFormat("en-IN", {
  timeZone: "UTC",
  month: "short",
  year: "numeric",
});

const DATETIME_IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** A YYYY-MM-DD date shown as "15 Oct 2026". Built in UTC, so no time-zone shift. */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return DATE_LONG.format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * One bucket shown as a label. A single day is "15 Oct 2026". A whole calendar month is
 * "Oct 2026". Anything else is a range.
 */
export function formatPeriod(start: string, end: string): string {
  if (start === end) return formatDay(start);
  const [sy, sm, sd] = start.split("-").map(Number) as [number, number, number];
  const lastOfMonth = new Date(Date.UTC(sy, sm, 0)).getUTCDate();
  const [ey, em, ed] = end.split("-").map(Number) as [number, number, number];
  if (sd === 1 && ey === sy && em === sm && ed === lastOfMonth) {
    return MONTH_YEAR.format(new Date(Date.UTC(sy, sm - 1, 1)));
  }
  return `${formatDay(start)} – ${formatDay(end)}`;
}

/** An ISO timestamp shown in Asia/Kolkata, for the screen and the PDF. */
export function formatDateTime(iso: string, style: FormatStyle): string {
  if (style === "csv") {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: IST,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .formatToParts(new Date(iso))
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }
  return DATETIME_IST.format(new Date(iso));
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/** Formats one cell for one style. Used by the CSV, Excel and PDF writers and by the page. */
export function formatCell(
  column: ReportColumn,
  row: Record<string, unknown>,
  style: FormatStyle,
): string {
  const raw = row[column.key];
  return formatValue(column.type, raw, row, style);
}

export function formatValue(
  type: ColumnType,
  raw: unknown,
  row: Record<string, unknown>,
  style: FormatStyle,
): string {
  switch (type) {
    case "money":
      return formatMoney(Number(raw ?? 0), style);
    case "unit_cost":
      return formatUnitCost(Number(raw ?? 0), style);
    case "int":
    case "points":
      return formatInt(Number(raw ?? 0), style);
    case "qty":
      return formatQty(Number(raw ?? 0), style);
    case "percent":
      return formatPercent(Number(raw ?? 0), style);
    case "bool":
      return raw === true ? "Yes" : raw === false ? "No" : "—";
    case "date":
      if (typeof raw !== "string" || !raw) return "—";
      return style === "csv" ? raw : formatDay(raw);
    case "datetime":
      if (typeof raw !== "string" || !raw) return "—";
      return formatDateTime(raw, style);
    case "period": {
      const start = typeof raw === "string" ? raw : "";
      const end = typeof row.period_end === "string" ? row.period_end : start;
      if (!start) return "—";
      if (style === "csv") return start === end ? start : `${start} to ${end}`;
      return formatPeriod(start, end);
    }
    case "text":
    default:
      return text(raw);
  }
}

/** The numeric value of a cell for Excel, or null where the cell is text. */
export function numericCellValue(type: ColumnType, raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (type) {
    case "money":
      return paiseToRupees(Number(raw));
    case "unit_cost":
      return Math.round(Number(raw) * 100) / 10000;
    case "int":
    case "points":
      return Math.round(Number(raw));
    case "qty":
      return Math.round(Number(raw) * 1000) / 1000;
    case "percent":
      return Math.round(Number(raw) * 100) / 100;
    default:
      return null;
  }
}

/** The Excel number format for a column type. */
export function excelNumberFormat(type: ColumnType): string | null {
  switch (type) {
    case "money":
      return "#,##0.00";
    case "unit_cost":
      return "#,##0.0000";
    case "int":
    case "points":
      return "#,##0";
    case "qty":
      return "#,##0.###";
    case "percent":
      return '0.00"%"';
    default:
      return null;
  }
}

/**
 * Text that is safe to put in PDF standard fonts. Maps the characters they lack to close
 * equivalents, so nothing shows as a missing glyph.
 */
export function toPdfText(value: string): string {
  return value
    .replace(/₹/g, "Rs. ")
    .replace(/−/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}
