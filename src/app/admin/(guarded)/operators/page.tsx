import type { Metadata } from "next";
import {
  OPERATOR_ROLE_LABELS,
  operatorCan,
  OPERATOR_ROLE_PERMISSIONS,
  type OperatorRole,
} from "@/modules/admin/access";
import { OperatorGrantForm, OperatorRevokeForm } from "@/modules/admin/components/admin-forms";
import {
  Cell,
  DataTable,
  PageHeader,
  ReadOnlyNote,
  Section,
  StatusBadge,
} from "@/modules/admin/components/admin-ui";
import { formatDateTime } from "@/modules/admin/format";
import { loadOperators } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Operators" };

const PERMISSION_TEXT: Record<string, string> = {
  view: "view the dashboard",
  support: "reply to tickets",
  plans: "change plans, subscriptions and overrides",
  tenants: "suspend businesses and deactivate staff",
  operators: "manage operator access",
};

export default async function OperatorsPage() {
  const op = await requireOperator("view");
  const canManage = operatorCan(op.permissions, "operators");
  const operators = await loadOperators();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operators"
        description="Who can use Super Admin, and in what role. The last active Super Admin cannot be removed, and you cannot revoke your own access."
      />

      <Section title="Roles">
        <ul className="grid gap-2 text-sm sm:grid-cols-3">
          {(Object.keys(OPERATOR_ROLE_PERMISSIONS) as OperatorRole[]).map((role) => (
            <li key={role} className="rounded-md border p-3">
              <p className="font-medium">{OPERATOR_ROLE_LABELS[role]}</p>
              <p className="text-muted-foreground text-xs">
                {OPERATOR_ROLE_PERMISSIONS[role].map((p) => PERMISSION_TEXT[p] ?? p).join("; ")}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Operator access">
        <DataTable
          headers={["Operator", "Role", "Granted", "Status", ""]}
          isEmpty={operators.length === 0}
          empty="No operators."
        >
          {operators.map((o) => (
            <tr key={o.user_id}>
              <Cell>
                {o.email ?? o.user_id}
                {o.user_id === op.userId ? (
                  <span className="text-muted-foreground text-xs"> (you)</span>
                ) : null}
              </Cell>
              <Cell>{OPERATOR_ROLE_LABELS[o.role]}</Cell>
              <Cell>{formatDateTime(o.granted_at)}</Cell>
              <Cell>
                {o.revoked_at ? <StatusBadge value="revoked" /> : <StatusBadge value="active" />}
              </Cell>
              <Cell>
                {canManage && !o.revoked_at && o.user_id !== op.userId ? (
                  <OperatorRevokeForm userId={o.user_id} />
                ) : null}
              </Cell>
            </tr>
          ))}
        </DataTable>
      </Section>

      {canManage ? (
        <Section
          title="Grant or change access"
          description="The person must already have a RestroNex account. Changes are recorded in the audit log."
        >
          <OperatorGrantForm />
        </Section>
      ) : (
        <ReadOnlyNote />
      )}
    </div>
  );
}
