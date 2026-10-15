import type { Metadata } from "next";
import Link from "next/link";
import {
  Cell,
  DataTable,
  Field,
  FilterBar,
  PageHeader,
  Pager,
  StatusBadge,
  adminInputClass,
} from "@/modules/admin/components/admin-ui";
import { pageFromParam, singleParam } from "@/modules/admin/format";
import { loadOutlets } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Outlets" };

export default async function OutletsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator("view");
  const params = await searchParams;
  const search = singleParam(params.q);
  const { page, offset } = pageFromParam(params.page);
  const result = await loadOutlets({ search, offset });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Outlets"
        description="Every outlet across all businesses, with its business status."
      />
      <FilterBar>
        <Field label="Search outlet name">
          <input name="q" defaultValue={search} className={adminInputClass} />
        </Field>
      </FilterBar>
      <DataTable
        headers={["Outlet", "Business", "Outlet status", "Business status", "Currency", "Timezone"]}
        isEmpty={result.rows.length === 0}
        empty="No outlets match this search."
      >
        {result.rows.map((o) => (
          <tr key={o.id}>
            <Cell>
              {o.name}
              <p className="text-muted-foreground text-xs">{o.slug}</p>
            </Cell>
            <Cell>
              {o.business_id ? (
                <Link
                  className="underline-offset-4 hover:underline"
                  href={`/admin/businesses/${o.business_id}`}
                >
                  {o.business_name}
                </Link>
              ) : (
                "—"
              )}
            </Cell>
            <Cell>
              <StatusBadge value={o.status} />
            </Cell>
            <Cell>
              <StatusBadge value={o.business_status} />
            </Cell>
            <Cell>{o.currency_code}</Cell>
            <Cell>{o.timezone}</Cell>
          </tr>
        ))}
      </DataTable>
      <Pager basePath="/admin/outlets" params={{ q: search }} page={page} total={result.total} />
    </div>
  );
}
