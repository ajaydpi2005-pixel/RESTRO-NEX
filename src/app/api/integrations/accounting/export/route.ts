import { NextResponse } from "next/server";
import { getSessionUserId, getViewerAbilities } from "@/lib/rbac/enforce";
import { buildAccountingCsv } from "@/modules/integrations/accounting";
import { findReport } from "@/modules/reports/registry";
import {
  EXPORT_ROW_LIMIT,
  exportRowsError,
  istToday,
  isUuid,
  parseReportFilters,
  type RawSearchParams,
} from "@/modules/reports/schemas";
import { loadOutletLabel, runReport } from "@/modules/reports/queries";

/**
 * Phase 18 — GET /api/integrations/accounting/export?business=…&outlet=…&from=…&to=…
 *
 * A synchronous CSV sales ledger built from the `sales-daily` report. It needs
 * reports.view, the same check as the reports export. It uses no connection and no
 * network, and the row cap applies: above the cap the export is refused, not truncated.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) return fail(401, "Sign in to export.");

  const url = new URL(request.url);
  const raw: RawSearchParams = {};
  for (const key of new Set(url.searchParams.keys())) raw[key] = url.searchParams.getAll(key);
  const single = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const businessId = single("business") ?? "";
  if (!isUuid(businessId)) return fail(400, "Choose a business.");

  const abilities = await getViewerAbilities(businessId);
  if (!abilities.userId || !abilities.can("reports.view")) {
    return fail(403, "Exports are not available for your role.");
  }

  const def = findReport("sales-daily");
  if (!def) return fail(500, "The sales report is not available.");

  const parsed = parseReportFilters(raw, def, istToday());
  if (parsed.error) return fail(400, parsed.error);
  const { filters } = parsed;

  const result = await runReport(def, {
    businessId,
    actorId: userId,
    outletId: filters.outletId,
    from: filters.from,
    to: filters.to,
    search: "",
    grain: "day",
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

  const outletLabel = await loadOutletLabel(businessId, filters.outletId);
  const csv = buildAccountingCsv(result.payload.rows, outletLabel);
  const filename = `accounting-sales-${filters.from}-to-${filters.to}.csv`;

  return new NextResponse(new TextEncoder().encode(csv), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...NO_STORE,
    },
  });
}
