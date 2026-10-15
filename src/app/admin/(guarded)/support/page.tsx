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
import { formatDateTime, pageFromParam, singleParam } from "@/modules/admin/format";
import { loadSupportQueue } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Support" };

export default async function SupportQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator("view");
  const params = await searchParams;
  const status = singleParam(params.status);
  const { page, offset } = pageFromParam(params.page);
  const queue = await loadSupportQueue({ status, offset });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Support queue"
        description="Tickets raised by restaurant owners and managers. Internal notes are hidden from the business."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Open" value={queue.counts.open} />
        <Metric label="Waiting for customer" value={queue.counts.waiting_customer} />
        <Metric label="Resolved" value={queue.counts.resolved} />
        <Metric label="Urgent, unresolved" value={queue.counts.urgent_unresolved} />
      </div>

      <FilterBar>
        <Field label="Status">
          <select name="status" defaultValue={status} className={adminInputClass}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="waiting_customer">Waiting for customer</option>
            <option value="resolved">Resolved</option>
          </select>
        </Field>
      </FilterBar>

      <DataTable
        headers={["Subject", "Business", "Status", "Priority", "Messages", "Last message"]}
        isEmpty={queue.rows.length === 0}
        empty="No tickets match this filter."
      >
        {queue.rows.map((t) => (
          <tr key={t.id} className="hover:bg-muted/40">
            <Cell>
              <Link
                className="font-medium underline-offset-4 hover:underline"
                href={`/admin/support/${t.id}`}
              >
                {t.subject}
              </Link>
            </Cell>
            <Cell>
              <Link
                className="underline-offset-4 hover:underline"
                href={`/admin/businesses/${t.business_id}`}
              >
                {t.business_name}
              </Link>
            </Cell>
            <Cell>
              <StatusBadge value={t.status} />
            </Cell>
            <Cell>
              <StatusBadge value={t.priority} />
            </Cell>
            <Cell className="tabular-nums">{t.message_count}</Cell>
            <Cell>{formatDateTime(t.last_message_at)}</Cell>
          </tr>
        ))}
      </DataTable>
      <Pager basePath="/admin/support" params={{ status }} page={page} total={queue.total} />
    </div>
  );
}
