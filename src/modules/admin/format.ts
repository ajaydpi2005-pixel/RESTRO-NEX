import { formatMinor } from "@/lib/money";

/**
 * Display helpers for the Super Admin dashboard (pure). Times use Asia/Kolkata,
 * the operator's timezone, so a trial end on "15 Oct" means the same day in
 * every view.
 */

const DISPLAY_TIME_ZONE = "Asia/Kolkata";

const dateTimeFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return dateTimeFormatter.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return dateFormatter.format(date);
}

/** Minor units with the currency code, e.g. ("INR", 123450) → "INR 1,234.50". */
export function formatCurrencyMinor(currency: string, minor: number): string {
  return `${currency} ${formatMinor(minor)}`;
}

/** Seconds → a short duration: 45 → "45 s", 300 → "5 min", 7200 → "2 h". */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/**
 * A date input value (YYYY-MM-DD) → the end of that day in IST, as ISO text.
 * Returns null for blank input and throws for anything malformed.
 */
export function endOfDayIst(dateText: string | null | undefined): string | null {
  const value = (dateText ?? "").trim();
  if (value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError("Enter a valid date.");
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError("Enter a valid date.");
  }
  return `${value}T23:59:59+05:30`;
}

export const PAGE_SIZE = 50;

/** Reads ?page= from a search-params object. Page numbers start at 1. */
export function pageFromParam(value: string | string[] | undefined): {
  page: number;
  offset: number;
} {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw ?? "1", 10);
  const page = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 10_000) : 1;
  return { page, offset: (page - 1) * PAGE_SIZE };
}

export function singleParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? "").trim();
}

export function pageHref(basePath: string, params: Record<string, string>, page: number): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  if (page > 1) search.set("page", String(page));
  const query = search.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/**
 * Effective value of a feature for display. An unlimited limit reads "Unlimited",
 * and a feature that is off reads "Off" whatever its limit.
 */
export function describeFeatureValue(entry: {
  kind: "boolean" | "limit";
  included: boolean;
  limit_value: number | null;
  unit: string | null;
}): string {
  if (!entry.included) return "Off";
  if (entry.kind === "boolean") return "On";
  if (entry.limit_value === null) return "Unlimited";
  return entry.unit ? `${entry.limit_value} ${entry.unit}` : String(entry.limit_value);
}

export function describeSource(source: "override" | "plan" | "none"): string {
  if (source === "override") return "Override";
  if (source === "plan") return "Plan";
  return "Not set";
}
