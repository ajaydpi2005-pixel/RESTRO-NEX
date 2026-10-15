import type { Metadata } from "next";
import Link from "next/link";
import {
  Cell,
  DataTable,
  Field,
  FilterBar,
  Metric,
  PageHeader,
  Section,
  StatusBadge,
  adminInputClass,
} from "@/modules/admin/components/admin-ui";
import {
  formatCurrencyMinor,
  formatDate,
  formatDateTime,
  singleParam,
} from "@/modules/admin/format";
import { loadUsage } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Usage" };

const WINDOWS = [7, 30, 90] as const;

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator("view");
  const params = await searchParams;
  const requested = Number(singleParam(params.days));
  const days = (WINDOWS as readonly number[]).includes(requested) ? requested : 30;
  const usage = await loadUsage(days);
  const t = usage.totals;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage"
        description={`Counts from the database for the last ${days} days (since ${formatDate(usage.since)}). Measured ${formatDateTime(usage.measured_at)}.`}
        actions={
          <FilterBar submitLabel="Show">
            <Field label="Window">
              <select name="days" defaultValue={String(days)} className={adminInputClass}>
                {WINDOWS.map((d) => (
                  <option key={d} value={d}>
                    Last {d} days
                  </option>
                ))}
              </select>
            </Field>
          </FilterBar>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Businesses" value={t.businesses} />
        <Metric label="Outlets" value={t.outlets} />
        <Metric label="Active staff" value={t.active_staff} />
        <Metric
          label="Orders"
          value={t.orders}
          note={`${t.channel_orders} from online or QR channels`}
        />
        <Metric label="Payments captured" value={t.payments_captured} />
        <Metric
          label="Captured value"
          value={
            t.payments_captured_minor_by_currency.length === 0
              ? "None"
              : t.payments_captured_minor_by_currency
                  .map((c) => formatCurrencyMinor(c.currency_code, c.minor))
                  .join(" · ")
          }
          note="Summed per currency. Currencies are never mixed."
        />
        <Metric label="Integration jobs" value={t.integration_jobs} />
        <Metric label="Customers (all time)" value={t.customers_all_time} />
      </div>

      <Section
        title="Per business"
        description="The 200 most recently created businesses. Storage used, API calls and feature-limit breaches are not measured in this phase, so those cells are not shown."
      >
        <DataTable
          headers={[
            "Business",
            "Status",
            "Outlets",
            "Active staff",
            "Orders",
            "Channel orders",
            "Captured",
            "Jobs (dead)",
            "Open tickets",
            "Last order",
          ]}
          isEmpty={usage.businesses.length === 0}
          empty="No businesses yet."
        >
          {usage.businesses.map((b) => (
            <tr key={b.id}>
              <Cell>
                <Link
                  className="underline-offset-4 hover:underline"
                  href={`/admin/businesses/${b.id}`}
                >
                  {b.name}
                </Link>
              </Cell>
              <Cell>
                <StatusBadge value={b.status} />
              </Cell>
              <Cell className="tabular-nums">
                {b.usage.outlets}
                {b.outlets_limit !== null ? (
                  <span className="text-muted-foreground"> / {b.outlets_limit}</span>
                ) : null}
              </Cell>
              <Cell className="tabular-nums">
                {b.usage.active_staff}
                {b.staff_limit !== null ? (
                  <span className="text-muted-foreground"> / {b.staff_limit}</span>
                ) : null}
              </Cell>
              <Cell className="tabular-nums">{b.usage.orders}</Cell>
              <Cell className="tabular-nums">{b.usage.channel_orders}</Cell>
              <Cell className="tabular-nums">
                {b.usage.payments_captured}
                {b.usage.payments_captured_minor_by_currency.length > 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {b.usage.payments_captured_minor_by_currency
                      .map((c) => formatCurrencyMinor(c.currency_code, c.minor))
                      .join(" · ")}
                  </p>
                ) : null}
              </Cell>
              <Cell className="tabular-nums">
                {b.usage.integration_jobs} ({b.usage.integration_jobs_dead})
              </Cell>
              <Cell className="tabular-nums">{b.usage.open_support_tickets}</Cell>
              <Cell>{formatDateTime(b.usage.last_order_at)}</Cell>
            </tr>
          ))}
        </DataTable>
        <p className="text-muted-foreground text-xs">
          Limits shown after a slash are plan or override values. Outlet and staff limits are
          recorded but not enforced yet; only online ordering and integrations are enforced in the
          database. A blank limit means unlimited.
        </p>
      </Section>
    </div>
  );
}
