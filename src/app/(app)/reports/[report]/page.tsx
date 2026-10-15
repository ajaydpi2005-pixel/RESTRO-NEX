import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import {
  ReportBasis,
  ReportExports,
  ReportFilters,
  ReportKpis,
  ReportsBusinessPicker,
  ReportsDenied,
  ReportsNoOutlet,
  ReportTable,
} from "@/modules/reports/components/report-chrome";
import { findReport, REPORT_GROUPS } from "@/modules/reports/registry";
import { runReport } from "@/modules/reports/queries";
import {
  istToday,
  pageOffset,
  parseReportFilters,
  PAGE_SIZE,
  type RawSearchParams,
} from "@/modules/reports/schemas";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ report: string }>;
}): Promise<Metadata> {
  const { report } = await params;
  const def = findReport(report);
  return { title: def ? `${def.title} report` : "Reports" };
}

export default async function ReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { report } = await params;
  const def = findReport(report);
  if (!def) notFound();

  const raw = await searchParams;
  const ctx = await loadInventoryPageContext(
    { business: typeof raw.business === "string" ? raw.business : undefined },
    "reports.view",
  );
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <ReportsBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <ReportsDenied />;
  if (ctx.kind === "no-outlet") return <ReportsNoOutlet />;

  const { business, abilities, outlets, userId } = ctx;
  if (def.extraPermission && !abilities.can(def.extraPermission)) {
    return (
      <ReportsDenied message={`${def.title} needs an extra permission your role does not have.`} />
    );
  }

  const parsed = parseReportFilters(raw, def, istToday());
  let { filters } = parsed;
  let filterError = parsed.error;
  if (filters.outletId && !outlets.some((o) => o.id === filters.outletId)) {
    filterError = "Choose an outlet from the list.";
    filters = { ...filters, outletId: null };
  }

  const result = await runReport(def, {
    businessId: business.id,
    actorId: userId,
    outletId: filters.outletId,
    from: filters.from,
    to: filters.to,
    search: filters.search,
    grain: filters.grain,
    limit: PAGE_SIZE,
    offset: pageOffset(filters.page),
  });

  const group = REPORT_GROUPS.find((g) => g.key === def.group);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          <Link
            href={`/reports?business=${business.id}`}
            className="hover:text-foreground underline-offset-4 hover:underline"
          >
            Reports
          </Link>
          {" / "}
          {group?.label}
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{def.title}</h1>
        <p className="text-muted-foreground">
          {business.name}. {def.description}
        </p>
      </div>

      <ReportBasis def={def} />

      {filterError && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {filterError} Showing the default filters instead.
        </p>
      )}

      <ReportFilters def={def} businessId={business.id} filters={filters} outlets={outlets} />

      {!result.ok && result.status === "forbidden" && <ReportsDenied message={result.error} />}

      {!result.ok && result.status !== "forbidden" && (
        <Card>
          <CardContent className="py-6">
            <p role="alert" className="text-sm text-red-900">
              {result.error}
            </p>
          </CardContent>
        </Card>
      )}

      {result.ok && (
        <>
          <ReportKpis def={def} summary={result.payload.summary} />
          <ReportExports def={def} businessId={business.id} filters={filters} />
          <ReportTable
            def={def}
            payload={result.payload}
            businessId={business.id}
            filters={filters}
          />
        </>
      )}
    </div>
  );
}
