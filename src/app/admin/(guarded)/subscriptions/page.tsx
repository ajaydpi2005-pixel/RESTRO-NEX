import type { Metadata } from "next";
import Link from "next/link";
import {
  Cell,
  DataTable,
  Field,
  FilterBar,
  Metric,
  PageHeader,
  Pager,
  StatusBadge,
  adminInputClass,
} from "@/modules/admin/components/admin-ui";
import { formatDate, formatDateTime, pageFromParam, singleParam } from "@/modules/admin/format";
import { loadSubscriptions } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Subscriptions" };

export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator("view");
  const params = await searchParams;
  const status = singleParam(params.status);
  const { page, offset } = pageFromParam(params.page);
  const result = await loadSubscriptions({ status, offset });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subscriptions"
        description="Operator-managed in this phase. Trials last 14 days by default. No payment provider is connected, so nothing is billed."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Trial" value={result.counts.trial} />
        <Metric label="Active" value={result.counts.active} />
        <Metric label="Past due" value={result.counts.past_due} />
        <Metric label="Cancelled" value={result.counts.cancelled} />
        <Metric label="No subscription" value={result.counts.businesses_without_subscription} />
      </div>

      <FilterBar>
        <Field label="Status">
          <select name="status" defaultValue={status} className={adminInputClass}>
            <option value="">All</option>
            <option value="trial">Trial</option>
            <option value="active">Active</option>
            <option value="past_due">Past due</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Field>
      </FilterBar>

      <DataTable
        headers={["Business", "Plan", "Status", "Trial ends", "Period ends", "Last change", ""]}
        isEmpty={result.rows.length === 0}
        empty="No subscriptions match this filter."
      >
        {result.rows.map((s) => (
          <tr key={s.business_id}>
            <Cell>
              <Link
                className="font-medium underline-offset-4 hover:underline"
                href={`/admin/businesses/${s.business_id}`}
              >
                {s.business_name}
              </Link>
              <p className="text-muted-foreground text-xs">Business: {s.business_status}</p>
            </Cell>
            <Cell>{s.plan_code}</Cell>
            <Cell>
              <StatusBadge value={s.status} />
            </Cell>
            <Cell>
              {formatDate(s.trial_ends_at)}
              {s.trial_ending_soon ? (
                <p className="text-gold-deep dark:text-gold text-xs">Ends within 7 days</p>
              ) : null}
            </Cell>
            <Cell>{formatDate(s.current_period_ends_at)}</Cell>
            <Cell>
              <span className="text-xs">{s.last_change_reason ?? "—"}</span>
              <p className="text-muted-foreground text-xs">{formatDateTime(s.updated_at)}</p>
            </Cell>
            <Cell>
              <Link
                className="text-xs underline-offset-4 hover:underline"
                href={`/admin/businesses/${s.business_id}`}
              >
                Change
              </Link>
            </Cell>
          </tr>
        ))}
      </DataTable>
      <Pager basePath="/admin/subscriptions" params={{ status }} page={page} total={result.total} />
    </div>
  );
}
