import { NextResponse } from "next/server";
import { getSessionUserId, getViewerAbilities } from "@/lib/rbac/enforce";
import { buildCsv } from "@/modules/reports/csv";
import { buildPdf } from "@/modules/reports/pdf";
import { buildXlsx } from "@/modules/reports/xlsx";
import { findReport } from "@/modules/reports/registry";
import {
  EXPORT_ROW_LIMIT,
  exportRowsError,
  istToday,
  isUuid,
  parseReportFilters,
  type RawSearchParams,
} from "@/modules/reports/schemas";
import { loadBusinessName, loadOutletLabel, runReport } from "@/modules/reports/queries";
import { formatDateTime, formatPeriod } from "@/modules/reports/format";
import type { ExportMeta } from "@/modules/reports/types";

/**
 * Phase 16 — GET /api/reports/export. Streams one report as CSV, Excel or PDF.
 *
 * Auth: a signed-in session is required (401). The business and report permission are checked
 * here for a fast 403, and the database checks them again. The export is refused with 413
 * above the row cap rather than sent truncated. Responses are never cached.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;

export async function GET(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) return fail(401, "Sign in to export reports.");

  const url = new URL(request.url);
  const raw: RawSearchParams = {};
  for (const key of new Set(url.searchParams.keys())) {
    raw[key] = url.searchParams.getAll(key);
  }
  const single = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const businessId = single("business") ?? "";
  if (!isUuid(businessId)) return fail(400, "Choose a business.");

  const def = findReport(single("report") ?? "");
  if (!def) return fail(404, "That report does not exist.");

  const format = single("format");
  if (format !== "csv" && format !== "xlsx" && format !== "pdf") {
    return fail(400, "Choose CSV, Excel or PDF.");
  }

  const abilities = await getViewerAbilities(businessId);
  if (!abilities.userId || !abilities.can("reports.view")) {
    return fail(403, "Reports are not available for your role.");
  }
  if (def.extraPermission && !abilities.can(def.extraPermission)) {
    return fail(403, "This report needs an extra permission your role does not have.");
  }

  const parsed = parseReportFilters(raw, def, istToday());
  if (parsed.error) return fail(400, parsed.error);
  const { filters } = parsed;

  const result = await runReport(def, {
    businessId,
    actorId: userId,
    outletId: filters.outletId,
    from: filters.from,
    to: filters.to,
    search: filters.search,
    grain: filters.grain,
    limit: EXPORT_ROW_LIMIT,
    offset: 0,
  });
  if (!result.ok) {
    if (result.status === "forbidden") return fail(403, result.error);
    if (result.status === "invalid") return fail(400, result.error);
    return fail(500, result.error);
  }

  const capError = exportRowsError(result.payload.total);
  if (capError) return fail(413, capError);

  const [businessName, outletLabel] = await Promise.all([
    loadBusinessName(businessId),
    loadOutletLabel(businessId, filters.outletId),
  ]);

  const meta: ExportMeta = {
    businessName,
    outletLabel,
    from: filters.from,
    to: filters.to,
    dateLabel: def.dates ? formatPeriod(filters.from, filters.to) : "",
    search: def.search ? filters.search : "",
    generatedAt: formatDateTime(new Date().toISOString(), "ui"),
    basis: def.basis,
  };

  let body: Uint8Array;
  if (format === "csv") {
    body = new TextEncoder().encode(buildCsv(def, result.payload));
  } else if (format === "xlsx") {
    body = await buildXlsx(def, result.payload, meta);
  } else {
    body = await buildPdf(def, result.payload, meta);
  }

  const span = def.dates ? `${filters.from}-${filters.to}` : istToday();
  const filename = `restronex-${def.slug}-${span}.${format}`;

  return new Response(body as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(body.byteLength),
      ...NO_STORE,
    },
  });
}
