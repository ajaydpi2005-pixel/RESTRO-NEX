import type { Metadata } from "next";
import Link from "next/link";
import { operatorCan } from "@/modules/admin/access";
import {
  Cell,
  DataTable,
  PageHeader,
  ReadOnlyNote,
  Section,
  StatusBadge,
} from "@/modules/admin/components/admin-ui";
import { formatDateTime } from "@/modules/admin/format";
import { loadOverrides, loadPlans } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Entitlements" };

export default async function EntitlementsPage() {
  const op = await requireOperator("view");
  const [plans, overrides] = await Promise.all([loadPlans(), loadOverrides()]);
  const catalog = plans[0]?.features ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feature entitlements"
        description="Which features each business may use. A business override beats its plan. Only features marked enforced are checked by the server; the rest are recorded but not enforced yet."
      />

      <Section title="Feature catalogue">
        <DataTable
          headers={["Feature", "Key", "Kind", "Enforced"]}
          isEmpty={catalog.length === 0}
          empty="No features are defined."
        >
          {catalog.map((f) => (
            <tr key={f.feature_key}>
              <Cell>{f.label}</Cell>
              <Cell className="font-mono text-xs">{f.feature_key}</Cell>
              <Cell>
                {f.kind === "limit" ? `Limit${f.unit ? ` (${f.unit})` : ""}` : "On / off"}
              </Cell>
              <Cell>
                {f.enforced ? (
                  <StatusBadge value="active" />
                ) : (
                  <span className="text-muted-foreground text-xs">Not enforced yet</span>
                )}
              </Cell>
            </tr>
          ))}
        </DataTable>
      </Section>

      <Section title="Business overrides" description="Set or remove these on the business page.">
        <DataTable
          headers={["Business", "Feature", "Included", "Limit", "Reason", "Updated"]}
          isEmpty={overrides.length === 0}
          empty="No business has an override."
        >
          {overrides.map((o) => (
            <tr key={`${o.business_id}-${o.feature_key}`}>
              <Cell>
                <Link
                  className="underline-offset-4 hover:underline"
                  href={`/admin/businesses/${o.business_id}`}
                >
                  {o.business_name}
                </Link>
              </Cell>
              <Cell>{o.label}</Cell>
              <Cell>{o.included === null ? "Uses plan" : o.included ? "Yes" : "No"}</Cell>
              <Cell>{o.limit_value ?? "Plan"}</Cell>
              <Cell className="text-xs">{o.reason}</Cell>
              <Cell>{formatDateTime(o.updated_at)}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>

      {operatorCan(op.permissions, "plans") ? null : <ReadOnlyNote />}
    </div>
  );
}
