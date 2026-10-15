import type { ReportDefinition } from "@/modules/reports/registry";
import type { ReportFilters } from "@/modules/reports/schemas";

/**
 * Phase 16 — builds the query strings shared by the filter form, pagination and export links,
 * so each link carries exactly the filters that apply to its report.
 */

export function reportQuery(
  def: ReportDefinition,
  businessId: string,
  filters: ReportFilters,
  extra: Record<string, string> = {},
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("business", businessId);
  if (def.dates) {
    params.set("from", filters.from);
    params.set("to", filters.to);
  }
  if (def.outlet && filters.outletId) params.set("outlet", filters.outletId);
  if (def.search && filters.search) params.set("q", filters.search);
  if (def.grain?.choose) params.set("grain", filters.grain);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params;
}

export function reportHref(
  def: ReportDefinition,
  businessId: string,
  filters: ReportFilters,
  extra: Record<string, string> = {},
): string {
  const query = reportQuery(def, businessId, filters, extra).toString();
  return `/reports/${def.slug}?${query}`;
}

export function exportHref(
  def: ReportDefinition,
  businessId: string,
  filters: ReportFilters,
  format: "csv" | "xlsx" | "pdf",
): string {
  const query = reportQuery(def, businessId, filters);
  query.set("report", def.slug);
  query.set("format", format);
  return `/api/reports/export?${query.toString()}`;
}
