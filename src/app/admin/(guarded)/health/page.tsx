import type { Metadata } from "next";
import { Metric, PageHeader, Section } from "@/modules/admin/components/admin-ui";
import { formatDateTime, formatSeconds } from "@/modules/admin/format";
import { loadOverviewHealth, measureDatabaseLatency } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Platform health" };

export default async function PlatformHealthPage() {
  await requireOperator("view");
  const [h, latencyMs] = await Promise.all([loadOverviewHealth(), measureDatabaseLatency()]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform health"
        description="Figures from the database and from timed round trips made just now. Anything that is not measured is labelled, never shown as zero."
      />

      <Section title="Database">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Round trip (now)"
            value={`${latencyMs} ms`}
            note="One admin function call, timed on this request"
          />
          <Metric label="Connection pool" value={null} note="Not measured" />
          <Metric
            label="Query errors (24 h)"
            value={null}
            note="Not measured: no error log is collected"
          />
          <Metric label="Figures measured" value={formatDateTime(h.measured_at)} />
        </div>
      </Section>

      <Section title="Integrations">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Accounts"
            value={h.integrations.accounts_total}
            note={`${h.integrations.accounts_live_enabled} live and ${h.integrations.accounts_demo_enabled} DEMO enabled`}
          />
          <Metric label="Accounts in error" value={h.integrations.accounts_in_error} />
          <Metric
            label="Jobs pending"
            value={h.integrations.jobs_pending}
            note={`${h.integrations.jobs_running} running`}
          />
          <Metric label="Dead jobs" value={h.integrations.jobs_dead} />
          <Metric
            label="Oldest due job"
            value={formatSeconds(h.integrations.oldest_due_job_seconds)}
            note={h.integrations.oldest_due_job_seconds === null ? "No job is waiting" : undefined}
          />
          <Metric label="Failed attempts (24 h)" value={h.integrations.attempts_failed_24h} />
          <Metric
            label="Retries scheduled (24 h)"
            value={h.integrations.attempts_retry_scheduled_24h}
          />
        </div>
      </Section>

      <Section title="Webhooks">
        <div className="grid gap-4 sm:grid-cols-3">
          <Metric
            label="Last webhook received"
            value={
              h.webhooks.last_received_at
                ? formatDateTime(h.webhooks.last_received_at)
                : "None recorded"
            }
          />
          <Metric label="Received (24 h)" value={h.webhooks.received_24h} />
          <Metric label="Failed (24 h)" value={h.webhooks.failed_24h} />
        </div>
      </Section>

      <Section title="Print agents">
        <div className="grid gap-4 sm:grid-cols-3">
          <Metric label="Registered" value={h.agents.registered} />
          <Metric label="Online (last 5 min)" value={h.agents.online_5m} />
          <Metric label="Revoked" value={h.agents.revoked} />
        </div>
      </Section>

      <Section title="Businesses and support">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Active" value={h.businesses.active} />
          <Metric label="Suspended" value={h.businesses.suspended} />
          <Metric label="Trials ending in 7 days" value={h.subscriptions.trial_ending_7d} />
          <Metric label="Urgent, unresolved tickets" value={h.support.urgent_unresolved} />
        </div>
      </Section>

      <Section
        title="Not measured in this phase"
        description="These need a probe, a log drain or a metrics service. None is faked here."
      >
        <ul className="text-muted-foreground list-inside list-disc text-sm">
          <li>Uptime and availability</li>
          <li>Application error rate and server latency percentiles</li>
          <li>Storage used per business</li>
          <li>Third-party provider API latency and quota</li>
        </ul>
      </Section>
    </div>
  );
}
