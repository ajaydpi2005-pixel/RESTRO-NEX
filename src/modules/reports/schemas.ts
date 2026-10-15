import type { ReportDefinition, ReportGrain } from "@/modules/reports/registry";

/**
 * Phase 16 — filter parsing for the report pages and the export route. Pure, so the
 * page and the API read the same rules. The database enforces the same limits
 * (400 days, 20,000 rows) as a second line of defence.
 */

export const MAX_RANGE_DAYS = 400;
export const PAGE_SIZE = 25;
export const EXPORT_ROW_LIMIT = 20000;
export const MAX_SEARCH_LENGTH = 80;
export const MAX_PAGE = 10000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRAINS: readonly ReportGrain[] = ["day", "week", "month"];

export type SearchParamValue = string | string[] | undefined;
export type RawSearchParams = Record<string, SearchParamValue>;

export interface ReportFilters {
  from: string;
  to: string;
  outletId: string | null;
  search: string;
  grain: ReportGrain;
  page: number;
}

export interface ParsedReportFilters {
  filters: ReportFilters;
  /** Set when a filter was invalid. The filters then fall back to their defaults. */
  error: string | null;
}

/** Today's date in Asia/Kolkata, as YYYY-MM-DD. */
export function istToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Adds whole days to a YYYY-MM-DD date. Uses UTC arithmetic, so there is no time-zone drift. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. Zero when they are the same day. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function first(value: SearchParamValue): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Reads filters from the URL. Defaults: the last 30 days in Asia/Kolkata, all accessible
 * outlets, day grain, page 1. An invalid value sets `error` and keeps the default, so the
 * page still shows something useful and says what was wrong.
 */
export function parseReportFilters(
  raw: RawSearchParams,
  def: Pick<ReportDefinition, "grain" | "dates" | "outlet" | "search">,
  today: string,
): ParsedReportFilters {
  const errors: string[] = [];

  let to = today;
  let from = addDays(today, -29);
  if (def.dates) {
    const fromRaw = first(raw.from);
    const toRaw = first(raw.to);
    if (fromRaw && !isIsoDate(fromRaw)) errors.push("Enter the start date as a real date.");
    else if (fromRaw) from = fromRaw;
    if (toRaw && !isIsoDate(toRaw)) errors.push("Enter the end date as a real date.");
    else if (toRaw) to = toRaw;
    if (!errors.length && from > to)
      errors.push("Choose a valid date range: the start is after the end.");
    if (!errors.length && daysBetween(from, to) > MAX_RANGE_DAYS) {
      errors.push(`Choose a date range of ${MAX_RANGE_DAYS} days or less.`);
    }
    if (errors.length) {
      from = addDays(today, -29);
      to = today;
    }
  }

  let outletId: string | null = null;
  if (def.outlet) {
    const outletRaw = first(raw.outlet);
    if (outletRaw) {
      if (isUuid(outletRaw)) outletId = outletRaw.toLowerCase();
      else errors.push("Choose an outlet from the list.");
    }
  }

  let grain: ReportGrain = def.grain && !def.grain.choose ? def.grain.value : "day";
  if (def.grain?.choose) {
    const grainRaw = first(raw.grain);
    if (grainRaw) {
      if ((GRAINS as readonly string[]).includes(grainRaw)) grain = grainRaw as ReportGrain;
      else errors.push("Choose day, week or month.");
    }
  }

  let search = "";
  if (def.search) {
    search = first(raw.q).slice(0, MAX_SEARCH_LENGTH);
  }

  let page = 1;
  const pageRaw = first(raw.page);
  if (pageRaw) {
    const parsed = Number(pageRaw);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE) page = parsed;
    else errors.push("Choose a page from the links.");
  }

  return {
    filters: { from, to, outletId, search, grain, page },
    error: errors[0] ?? null,
  };
}

export function pageOffset(page: number, pageSize: number = PAGE_SIZE): number {
  return (page - 1) * pageSize;
}

export function pageCount(total: number, pageSize: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** The export route refuses reports above the row cap, rather than writing a partial file. */
export function exportRowsError(total: number): string | null {
  if (total > EXPORT_ROW_LIMIT) {
    return `This report has ${total.toLocaleString("en-IN")} rows. Exports are capped at ${EXPORT_ROW_LIMIT.toLocaleString("en-IN")}. Narrow the date range or outlet, then export again.`;
  }
  return null;
}
