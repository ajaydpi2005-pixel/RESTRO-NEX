import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatCell, formatValue } from "@/modules/reports/format";
import type { ReportDefinition, ReportColumn } from "@/modules/reports/registry";
import { REPORT_GROUPS, reportsInGroup } from "@/modules/reports/registry";
import { PAGE_SIZE, pageCount, type ReportFilters } from "@/modules/reports/schemas";
import type { ReportPayload } from "@/modules/reports/types";
import { exportHref, reportHref } from "@/modules/reports/urls";

/**
 * Phase 16 — server-rendered pieces of the reports pages. There is no client JavaScript: the
 * filter form is a plain GET, and paging and export are links.
 */

const panel = "rounded-lg border bg-card text-card-foreground";

export function ReportsBusinessPicker({
  businesses,
}: {
  businesses: { id: string; name: string; role: string }[];
}) {
  return (
    <section className={cn(panel, "p-6")}>
      <h2 className="text-lg font-semibold">Choose a business</h2>
      <p className="text-muted-foreground mt-1 text-sm">Reports are for one business at a time.</p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {businesses.map((b) => (
          <li key={b.id}>
            <Link
              href={`/reports?business=${b.id}`}
              className={cn(buttonVariants({ variant: "outline" }), "w-full justify-start")}
            >
              {b.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReportsDenied({ message }: { message?: string }) {
  return (
    <section className={cn(panel, "p-6")}>
      <h2 className="text-lg font-semibold">Reports are not available for your role</h2>
      <p className="text-muted-foreground mt-2 text-sm">
        {message ?? "Ask an owner or business admin to give you access to reports."}
      </p>
    </section>
  );
}

export function ReportsNoOutlet() {
  return (
    <section className={cn(panel, "p-6")}>
      <h2 className="text-lg font-semibold">No outlet to report on</h2>
      <p className="text-muted-foreground mt-2 text-sm">
        Your membership does not include any outlet in this business. Ask an owner to assign one.
      </p>
    </section>
  );
}

export function ReportHub({
  businessId,
  businessName,
  canSee,
}: {
  businessId: string;
  businessName: string;
  canSee: (def: ReportDefinition) => boolean;
}) {
  return (
    <div className="space-y-8">
      <p className="text-muted-foreground text-sm">
        Figures for <span className="text-foreground font-medium">{businessName}</span>, read from
        the live ledger. Money is shown in rupees.
      </p>
      {REPORT_GROUPS.map((group) => (
        <section key={group.key} className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">{group.label}</h2>
            <p className="text-muted-foreground text-sm">{group.description}</p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {reportsInGroup(group.key).map((def) => {
              const allowed = canSee(def);
              const body = (
                <>
                  <span className="font-medium">{def.title}</span>
                  <span className="text-muted-foreground mt-1 block text-xs">
                    {def.description}
                  </span>
                  {!allowed && (
                    <span className="text-muted-foreground mt-2 block text-xs">
                      Needs an extra permission your role does not have.
                    </span>
                  )}
                </>
              );
              return (
                <li key={def.slug}>
                  {allowed ? (
                    <Link
                      href={`/reports/${def.slug}?business=${businessId}`}
                      className={cn(panel, "hover:bg-muted/50 block p-4 transition-colors")}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className={cn(panel, "block p-4 opacity-60")}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function ReportFilters({
  def,
  businessId,
  filters,
  outlets,
}: {
  def: ReportDefinition;
  businessId: string;
  filters: ReportFilters;
  outlets: { id: string; name: string }[];
}) {
  const hasAny = def.dates || def.outlet || def.search || def.grain?.choose;
  if (!hasAny) return null;
  return (
    <form
      method="get"
      action={`/reports/${def.slug}`}
      className={cn(panel, "grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6 lg:items-end")}
    >
      <input type="hidden" name="business" value={businessId} />
      {def.dates && (
        <>
          <div className="space-y-1">
            <Label htmlFor="from">From</Label>
            <Input id="from" name="from" type="date" defaultValue={filters.from} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="to">To</Label>
            <Input id="to" name="to" type="date" defaultValue={filters.to} />
          </div>
        </>
      )}
      {def.outlet && (
        <div className="space-y-1">
          <Label htmlFor="outlet">Outlet</Label>
          <select
            id="outlet"
            name="outlet"
            defaultValue={filters.outletId ?? ""}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="">All outlets</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {def.grain?.choose && (
        <div className="space-y-1">
          <Label htmlFor="grain">Group by</Label>
          <select
            id="grain"
            name="grain"
            defaultValue={filters.grain}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </div>
      )}
      {def.search && (
        <div className="space-y-1">
          <Label htmlFor="q">Search</Label>
          <Input
            id="q"
            name="q"
            defaultValue={filters.search}
            placeholder={def.search}
            maxLength={80}
          />
        </div>
      )}
      <div>
        <Button type="submit" className="w-full">
          Apply
        </Button>
      </div>
    </form>
  );
}

export function ReportKpis({
  def,
  summary,
}: {
  def: ReportDefinition;
  summary: Record<string, unknown>;
}) {
  if (def.summary.length === 0) return null;
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {def.summary.map((item) => (
        <div key={item.key} className={cn(panel, "p-4")}>
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">{item.label}</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">
            {formatValue(item.type, summary[item.key], {}, "ui")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function alignClass(column: ReportColumn): string {
  return ["money", "unit_cost", "int", "points", "qty", "percent"].includes(column.type)
    ? "text-right tabular-nums"
    : "text-left";
}

export function ReportTable({
  def,
  payload,
  businessId,
  filters,
}: {
  def: ReportDefinition;
  payload: ReportPayload;
  businessId: string;
  filters: ReportFilters;
}) {
  const barKey = def.bar;
  const barMax = barKey ? Math.max(0, ...payload.rows.map((r) => Number(r[barKey] ?? 0))) : 0;
  const pages = pageCount(payload.total);
  const from = payload.total === 0 ? 0 : (filters.page - 1) * PAGE_SIZE + 1;
  const to = Math.min(payload.total, filters.page * PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className={cn(panel, "overflow-x-auto")}>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs tracking-wide uppercase">
            <tr>
              {def.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn("px-3 py-2 font-medium whitespace-nowrap", alignClass(c))}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {payload.rows.length === 0 && (
              <tr>
                <td
                  colSpan={def.columns.length}
                  className="text-muted-foreground px-3 py-8 text-center"
                >
                  No rows for this filter. Try a wider date range or another outlet.
                </td>
              </tr>
            )}
            {payload.rows.map((row, index) => (
              <tr key={index} className="border-t">
                {def.columns.map((c) => {
                  const text = formatCell(c, row, "ui");
                  const isBar = barKey === c.key && barMax > 0;
                  const pct = isBar ? Math.max(0, (Number(row[c.key] ?? 0) / barMax) * 100) : 0;
                  return (
                    <td key={c.key} className={cn("relative px-3 py-2 align-top", alignClass(c))}>
                      {isBar && (
                        <span
                          aria-hidden
                          className="bg-primary/10 absolute inset-y-1 left-0 rounded-sm"
                          style={{ width: `${pct.toFixed(2)}%` }}
                        />
                      )}
                      <span className="relative">{text}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground">
          {payload.total === 0
            ? "No rows"
            : `Showing ${from}–${to} of ${payload.total.toLocaleString("en-IN")}`}
        </p>
        {pages > 1 && (
          <nav aria-label="Pagination" className="flex items-center gap-2">
            {filters.page > 1 ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={reportHref(def, businessId, filters, { page: String(filters.page - 1) })}
              >
                Previous
              </Link>
            ) : (
              <span
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "pointer-events-none opacity-50",
                )}
              >
                Previous
              </span>
            )}
            <span className="text-muted-foreground">
              Page {filters.page} of {pages}
            </span>
            {filters.page < pages ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={reportHref(def, businessId, filters, { page: String(filters.page + 1) })}
              >
                Next
              </Link>
            ) : (
              <span
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "pointer-events-none opacity-50",
                )}
              >
                Next
              </span>
            )}
          </nav>
        )}
      </div>
    </div>
  );
}

export function ReportExports({
  def,
  businessId,
  filters,
}: {
  def: ReportDefinition;
  businessId: string;
  filters: ReportFilters;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground mr-1 text-sm">Export all matching rows:</span>
      {(
        [
          ["csv", "CSV"],
          ["xlsx", "Excel"],
          ["pdf", "PDF"],
        ] as const
      ).map(([format, label]) => (
        <a
          key={format}
          href={exportHref(def, businessId, filters, format)}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {label}
        </a>
      ))}
    </div>
  );
}

export function ReportBasis({ def }: { def: ReportDefinition }) {
  return (
    <p className="text-muted-foreground text-sm">
      <span className="text-foreground font-medium">How this is counted: </span>
      {def.basis}
    </p>
  );
}
