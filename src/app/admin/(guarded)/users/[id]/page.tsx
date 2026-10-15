import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OPERATOR_ROLE_LABELS, isOperatorRole } from "@/modules/admin/access";
import {
  Cell,
  DataTable,
  PageHeader,
  Section,
  StatusBadge,
} from "@/modules/admin/components/admin-ui";
import { formatDateTime } from "@/modules/admin/format";
import { isUuid } from "@/modules/admin/schemas";
import { loadUserDetail } from "@/modules/admin/queries";
import { orNotFound } from "@/modules/admin/rpc";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "User" };

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  await requireOperator("view");
  const detail = await orNotFound(loadUserDetail(id));
  const { user, operator, memberships } = detail;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/admin/users" className="text-muted-foreground hover:text-foreground text-sm">
          ← Users
        </Link>
        <PageHeader title={user.email ?? "Account"} description={user.full_name ?? undefined} />
      </div>

      <Section title="Account">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground text-xs">Created</dt>
            <dd>{formatDateTime(user.created_at)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Last sign-in</dt>
            <dd>{formatDateTime(user.last_sign_in_at)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Phone</dt>
            <dd>{user.phone ?? "Not set"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Operator role</dt>
            <dd>
              {operator && isOperatorRole(operator.role) ? (
                <>
                  {OPERATOR_ROLE_LABELS[operator.role]}{" "}
                  {operator.revoked ? <StatusBadge value="revoked" /> : null}
                </>
              ) : (
                "Not an operator"
              )}
            </dd>
          </div>
        </dl>
        <p className="text-muted-foreground text-xs">
          Operator access is granted and revoked on the{" "}
          <Link className="underline" href="/admin/operators">
            Operators
          </Link>{" "}
          page.
        </p>
      </Section>

      <Section title="Business memberships">
        <DataTable
          headers={["Business", "Role", "Status", "Since"]}
          isEmpty={memberships.length === 0}
          empty="This account has no memberships."
        >
          {memberships.map((m) => (
            <tr key={m.membership_id}>
              <Cell>
                <Link
                  className="underline-offset-4 hover:underline"
                  href={`/admin/businesses/${m.business_id}`}
                >
                  {m.business_name}
                </Link>
              </Cell>
              <Cell>{m.role}</Cell>
              <Cell>
                <StatusBadge value={m.status} />
              </Cell>
              <Cell>{formatDateTime(m.created_at)}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
    </div>
  );
}
