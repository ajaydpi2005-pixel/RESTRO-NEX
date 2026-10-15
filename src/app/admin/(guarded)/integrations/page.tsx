import type { Metadata } from "next";
import Link from "next/link";
import {
  Cell,
  DataTable,
  Metric,
  PageHeader,
  Section,
  StatusBadge,
} from "@/modules/admin/components/admin-ui";
import { formatDateTime } from "@/modules/admin/format";
import { loadIntegrationHealth } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Integration health" };

export default async function IntegrationHealthPage() {
  await requireOperator("view");
  const health = await loadIntegrationHealth();
  const { accounts, agents } = health;

  // Counts are taken from the rows returned, which are capped at 200 by the query.
  const inError = accounts.filter((a) => a.status === "error").length;
  const liveEnabled = accounts.filter((a) => a.enabled && a.mode === "live").length;
  const demoEnabled = accounts.filter((a) => a.enabled && a.mode === "demo").length;
  const online = agents.filter((a) => a.state === "online").length;
  const capped = accounts.length >= 200;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integration health"
        description="Connection status for every integration account and print agent. Credentials are never shown here."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Accounts listed"
          value={accounts.length}
          note={capped ? "Showing the first 200" : undefined}
        />
        <Metric label="In error" value={inError} />
        <Metric label="Live enabled" value={liveEnabled} note={`${demoEnabled} DEMO enabled`} />
        <Metric
          label="Print agents online"
          value={online}
          note={`of ${agents.filter((a) => a.state !== "revoked").length} active; online means seen in the last 5 minutes`}
        />
      </div>

      <Section
        title="Accounts"
        description="DEMO accounts send nothing to a provider. Live mode is blocked for Swiggy and Zomato in the database."
      >
        <DataTable
          headers={[
            "Business",
            "Outlet",
            "Provider",
            "Mode",
            "Enabled",
            "Status",
            "Last success",
            "Pending / dead",
            "Failed (24 h)",
            "Last error",
          ]}
          isEmpty={accounts.length === 0}
          empty="No integration accounts are configured."
        >
          {accounts.map((a) => (
            <tr key={a.id}>
              <Cell>
                <Link
                  className="underline-offset-4 hover:underline"
                  href={`/admin/businesses/${a.business_id}`}
                >
                  {a.business_name}
                </Link>
              </Cell>
              <Cell>{a.outlet_name ?? "Business-wide"}</Cell>
              <Cell>{a.provider}</Cell>
              <Cell>{a.mode.toUpperCase()}</Cell>
              <Cell>{a.enabled ? "Yes" : "No"}</Cell>
              <Cell>
                <StatusBadge value={a.status} />
              </Cell>
              <Cell>{formatDateTime(a.last_success_at)}</Cell>
              <Cell className="tabular-nums">
                {a.pending_jobs} / {a.dead_jobs}
              </Cell>
              <Cell className="tabular-nums">{a.failed_attempts_24h}</Cell>
              <Cell className="max-w-xs text-xs">{a.last_error ?? "—"}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>

      <Section
        title="Print agents"
        description="A print agent is a small program on a machine inside the restaurant. It polls for jobs; the server never connects to a printer directly."
      >
        <DataTable
          headers={["Business", "Outlet", "Agent", "State", "Last seen", "Registered"]}
          isEmpty={agents.length === 0}
          empty="No print agents are registered."
        >
          {agents.map((g) => (
            <tr key={g.id}>
              <Cell>
                <Link
                  className="underline-offset-4 hover:underline"
                  href={`/admin/businesses/${g.business_id}`}
                >
                  {g.business_name}
                </Link>
              </Cell>
              <Cell>{g.outlet_name ?? "—"}</Cell>
              <Cell>{g.name}</Cell>
              <Cell>
                <StatusBadge value={g.state} />
              </Cell>
              <Cell>{formatDateTime(g.last_seen_at)}</Cell>
              <Cell>{formatDateTime(g.created_at)}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
    </div>
  );
}
