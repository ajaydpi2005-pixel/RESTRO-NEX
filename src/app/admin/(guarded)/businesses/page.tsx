import type { Metadata } from "next";
import Link from "next/link";
import {
  Cell,
  DataTable,
  FilterBar,
  Field,
  PageHeader,
  Pager,
  StatusBadge,
  adminInputClass,
} from "@/modules/admin/components/admin-ui";
import { formatDate, formatDateTime, pageFromParam, singleParam } from "@/modules/admin/format";
import { loadBusinesses } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Businesses" };

export default async function BusinessesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator("view");
  const params = await searchParams;
  const search = singleParam(params.q);
  const status = singleParam(params.status);
  const { page, offset } = pageFromParam(params.page);
  const result = await loadBusinesses({ search, status, offset });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Businesses"
        description="Every restaurant business on RestroNex. Suspension locks all of its staff out."
      />
      <FilterBar>
        <Field label="Search name or slug">
          <input name="q" defaultValue={search} className={adminInputClass} />
        </Field>
        <Field label="Status">
          <select name="status" defaultValue={status} className={adminInputClass}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="closed">Closed</option>
          </select>
        </Field>
      </FilterBar>

      <DataTable
        headers={[
          "Business",
          "Status",
          "Plan",
          "Subscription",
          "Trial ends",
          "Outlets",
          "Active staff",
          "Created",
        ]}
        isEmpty={result.rows.length === 0}
        empty="No businesses match these filters."
      >
        {result.rows.map((b) => (
          <tr key={b.id} className="hover:bg-muted/40">
            <Cell>
              <Link
                className="font-medium underline-offset-4 hover:underline"
                href={`/admin/businesses/${b.id}`}
              >
                {b.name}
              </Link>
              <p className="text-muted-foreground text-xs">{b.slug}</p>
            </Cell>
            <Cell>
              <StatusBadge value={b.status} />
            </Cell>
            <Cell>{b.plan_code ?? <span className="text-muted-foreground">No plan</span>}</Cell>
            <Cell>
              <StatusBadge value={b.subscription_status} />
            </Cell>
            <Cell>{formatDate(b.trial_ends_at)}</Cell>
            <Cell className="tabular-nums">{b.outlet_count}</Cell>
            <Cell className="tabular-nums">{b.active_staff}</Cell>
            <Cell>{formatDateTime(b.created_at)}</Cell>
          </tr>
        ))}
      </DataTable>
      <Pager
        basePath="/admin/businesses"
        params={{ q: search, status }}
        page={page}
        total={result.total}
      />
    </div>
  );
}
