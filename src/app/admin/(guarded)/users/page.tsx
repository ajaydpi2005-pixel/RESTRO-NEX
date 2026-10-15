import type { Metadata } from "next";
import Link from "next/link";
import {
  Cell,
  DataTable,
  Field,
  FilterBar,
  PageHeader,
  Pager,
  adminInputClass,
} from "@/modules/admin/components/admin-ui";
import { formatDateTime, pageFromParam, singleParam } from "@/modules/admin/format";
import { OPERATOR_ROLE_LABELS, isOperatorRole } from "@/modules/admin/access";
import { loadUsers } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator("view");
  const params = await searchParams;
  const search = singleParam(params.q);
  const { page, offset } = pageFromParam(params.page);
  const result = await loadUsers({ search, offset });

  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="Accounts on RestroNex. Search by email or name." />
      <FilterBar>
        <Field label="Search email or name">
          <input name="q" defaultValue={search} className={adminInputClass} />
        </Field>
      </FilterBar>
      <DataTable
        headers={["Account", "Created", "Last sign-in", "Active memberships", "Operator"]}
        isEmpty={result.rows.length === 0}
        empty="No accounts match this search."
      >
        {result.rows.map((u) => (
          <tr key={u.id} className="hover:bg-muted/40">
            <Cell>
              <Link
                className="font-medium underline-offset-4 hover:underline"
                href={`/admin/users/${u.id}`}
              >
                {u.email ?? "No email"}
              </Link>
              {u.full_name ? <p className="text-muted-foreground text-xs">{u.full_name}</p> : null}
            </Cell>
            <Cell>{formatDateTime(u.created_at)}</Cell>
            <Cell>{formatDateTime(u.last_sign_in_at)}</Cell>
            <Cell className="tabular-nums">{u.active_memberships}</Cell>
            <Cell>
              {u.operator_role && isOperatorRole(u.operator_role)
                ? OPERATOR_ROLE_LABELS[u.operator_role]
                : "—"}
            </Cell>
          </tr>
        ))}
      </DataTable>
      <Pager basePath="/admin/users" params={{ q: search }} page={page} total={result.total} />
    </div>
  );
}
