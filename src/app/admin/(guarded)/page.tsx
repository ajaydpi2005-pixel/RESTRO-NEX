import type { Metadata } from "next";
import Link from "next/link";
import { Metric, PageHeader, Section } from "@/modules/admin/components/admin-ui";
import { loadOverviewHealth, measureDatabaseLatency } from "@/modules/admin/queries";
import { formatDateTime } from "@/modules/admin/format";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Overview" };

export default async function AdminOverviewPage() {
  await requireOperator("view");
  const [health, latencyMs] = await Promise.all([loadOverviewHealth(), measureDatabaseLatency()]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Live platform figures from the database. Nothing on this page is estimated; a figure that cannot be measured says so."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Active businesses"
          value={health.businesses.active}
          note={`${health.businesses.suspended} suspended · ${health.businesses.closed} closed`}
        />
        <Metric
          label="Trials"
          value={health.subscriptions.trial}
          note={`${health.subscriptions.trial_ending_7d} ending in 7 days`}
        />
        <Metric
          label="Paying (active)"
          value={health.subscriptions.active}
          note={`${health.subscriptions.past_due} past due`}
        />
        <Metric
          label="Open support tickets"
          value={health.support.open + health.support.waiting_customer}
          note={`${health.support.urgent_unresolved} urgent unresolved`}
        />
        <Metric
          label="Integration accounts in error"
          value={health.integrations.accounts_in_error}
          note={`of ${health.integrations.accounts_total} connected`}
        />
        <Metric
          label="Dead integration jobs"
          value={health.integrations.jobs_dead}
          note={`${health.integrations.jobs_pending} pending`}
        />
        <Metric label="Database round trip" value={`${latencyMs} ms`} note="Measured just now" />
        <Metric label="Uptime" value={null} note="Not measured: no uptime probe is configured." />
      </div>

      <Section title="Shortcuts" description="Go to the area you need.">
        <ul className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
          <li>
            <Link className="underline underline-offset-4" href="/admin/businesses">
              Businesses
            </Link>
          </li>
          <li>
            <Link className="underline underline-offset-4" href="/admin/subscriptions">
              Subscriptions
            </Link>
          </li>
          <li>
            <Link className="underline underline-offset-4" href="/admin/support">
              Support queue
            </Link>
          </li>
          <li>
            <Link className="underline underline-offset-4" href="/admin/integrations">
              Integration health
            </Link>
          </li>
          <li>
            <Link className="underline underline-offset-4" href="/admin/audit">
              Operator audit log
            </Link>
          </li>
          <li>
            <Link className="underline underline-offset-4" href="/admin/health">
              Platform health
            </Link>
          </li>
        </ul>
        <p className="text-muted-foreground text-xs">
          Figures measured {formatDateTime(health.measured_at)}. Operator actions in the last 24
          hours: {health.admin_actions_24h}. Tenant audit events in the last 24 hours:{" "}
          {health.tenant_audit_events_24h}.
        </p>
      </Section>
    </div>
  );
}
