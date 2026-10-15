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
import { isUuid } from "@/modules/admin/schemas";
import { loadAdminAudit } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator("view");
  const params = await searchParams;
  const rawBusiness = singleParam(params.business);
  const businessId = isUuid(rawBusiness) ? rawBusiness : "";
  const { page, offset } = pageFromParam(params.page);
  const audit = await loadAdminAudit({ businessId, offset });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operator audit log"
        description="Every operator change: who, when, what, the reason, and the state before and after. Append-only: nothing here can be edited or deleted."
      />
      <FilterBar>
        <Field label="Business ID" hint="Optional. Paste a business ID to narrow the list.">
          <input name="business" defaultValue={businessId} className={adminInputClass} />
        </Field>
      </FilterBar>
      <DataTable
        headers={["When", "Operator", "Action", "Target", "Reason", "Change"]}
        isEmpty={audit.rows.length === 0}
        empty="No operator changes match."
      >
        {audit.rows.map((row) => (
          <tr key={row.id}>
            <Cell>{formatDateTime(row.created_at)}</Cell>
            <Cell className="text-xs">
              {row.actor_email ?? "Removed account"}
              <p className="text-muted-foreground">{row.actor_role.replaceAll("_", " ")}</p>
            </Cell>
            <Cell className="font-mono text-xs">{row.action}</Cell>
            <Cell className="text-xs">
              {row.target_type}
              {row.business_id ? (
                <p>
                  <Link
                    className="underline-offset-4 hover:underline"
                    href={`/admin/businesses/${row.business_id}`}
                  >
                    business
                  </Link>
                </p>
              ) : null}
            </Cell>
            <Cell className="max-w-xs text-xs">{row.reason}</Cell>
            <Cell className="max-w-sm">
              <details>
                <summary className="cursor-pointer text-xs underline-offset-4 hover:underline">
                  Show before and after
                </summary>
                <pre className="bg-muted mt-2 max-h-60 overflow-auto rounded p-2 text-[11px] leading-snug">
                  {JSON.stringify({ before: row.before_state, after: row.after_state }, null, 2)}
                </pre>
              </details>
            </Cell>
          </tr>
        ))}
      </DataTable>
      <Pager
        basePath="/admin/audit"
        params={{ business: businessId }}
        page={page}
        total={audit.total}
      />
    </div>
  );
}
