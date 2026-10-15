import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { operatorCan } from "@/modules/admin/access";
import {
  BusinessStatusForm,
  DeactivateMembershipForm,
  OverrideForm,
  SubscriptionForm,
} from "@/modules/admin/components/admin-forms";
import {
  Cell,
  DataTable,
  FilterBar,
  Field,
  Metric,
  PageHeader,
  ReadOnlyNote,
  Section,
  StatusBadge,
  adminInputClass,
} from "@/modules/admin/components/admin-ui";
import {
  describeFeatureValue,
  describeSource,
  formatCurrencyMinor,
  formatDate,
  formatDateTime,
  singleParam,
} from "@/modules/admin/format";
import { isUuid } from "@/modules/admin/schemas";
import { loadBusinessDetail, loadPlans, loadTenantAudit } from "@/modules/admin/queries";
import { orNotFound } from "@/modules/admin/rpc";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Business" };

export default async function BusinessDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const query = await searchParams;
  const prefix = singleParam(query.prefix);

  const op = await requireOperator("view");
  const canTenants = operatorCan(op.permissions, "tenants");
  const canPlans = operatorCan(op.permissions, "plans");

  const [detail, plans, activity] = await Promise.all([
    orNotFound(loadBusinessDetail(id)),
    loadPlans(),
    loadTenantAudit({ businessId: id, prefix, limit: 50 }),
  ]);
  const {
    business,
    subscription,
    outlets,
    members,
    entitlements,
    overrides,
    usage_30d: usage,
  } = detail;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/admin/businesses"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Businesses
        </Link>
        <PageHeader
          title={business.name}
          description={`${business.slug} · created ${formatDateTime(business.created_at)} · last changed ${formatDateTime(business.updated_at)}`}
          actions={<StatusBadge value={business.status} />}
        />
      </div>

      <Section
        title="Business status"
        description="Suspending locks every staff member out. Reactivation restores only the access the suspension changed."
      >
        {business.status === "closed" ? (
          <ReadOnlyNote />
        ) : canTenants ? (
          <BusinessStatusForm businessId={business.id} current={business.status} />
        ) : (
          <ReadOnlyNote />
        )}
      </Section>

      <Section
        title="Subscription"
        description="Operator-managed in this phase. No payment provider is connected, so no charge is taken."
      >
        {subscription ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground text-xs">Plan</dt>
              <dd>{subscription.plan_name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Status</dt>
              <dd>
                <StatusBadge value={subscription.status} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Trial ends</dt>
              <dd>{formatDate(subscription.trial_ends_at)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Period ends</dt>
              <dd>{formatDate(subscription.current_period_ends_at)}</dd>
            </div>
            <div className="sm:col-span-4">
              <dt className="text-muted-foreground text-xs">Last change reason</dt>
              <dd>{subscription.last_change_reason ?? "—"}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground text-sm">
            No subscription is recorded for this business.
          </p>
        )}
        {canPlans ? (
          <SubscriptionForm
            businessId={business.id}
            plans={plans.filter((p) => p.is_active || p.code === subscription?.plan_code)}
            current={subscription}
          />
        ) : (
          <ReadOnlyNote />
        )}
      </Section>

      <Section
        title="Feature entitlements"
        description="Effective value = override if set, otherwise the plan. Only features marked enforced are checked by the server."
      >
        <DataTable
          headers={["Feature", "Effective value", "Source", "Enforced", "Override"]}
          isEmpty={entitlements.length === 0}
          empty="No features are defined."
        >
          {entitlements.map((e) => {
            const override = overrides.find((o) => o.feature_key === e.feature_key);
            return (
              <tr key={e.feature_key}>
                <Cell>{e.label}</Cell>
                <Cell>{describeFeatureValue(e)}</Cell>
                <Cell>{describeSource(e.source)}</Cell>
                <Cell>{e.enforced ? "Yes" : "Not enforced yet"}</Cell>
                <Cell>
                  {override ? (
                    <span className="text-xs">
                      {override.included === null ? "uses plan" : override.included ? "on" : "off"}
                      {override.limit_value !== null ? ` · limit ${override.limit_value}` : ""}
                      <br />
                      <span className="text-muted-foreground">{override.reason}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">none</span>
                  )}
                </Cell>
              </tr>
            );
          })}
        </DataTable>
        {canPlans ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {entitlements.map((e) => (
              <OverrideForm
                key={e.feature_key}
                businessId={business.id}
                feature={e}
                current={overrides.find((o) => o.feature_key === e.feature_key) ?? null}
              />
            ))}
          </div>
        ) : (
          <ReadOnlyNote />
        )}
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Outlets">
          <DataTable
            headers={["Outlet", "Status", "Currency", "Timezone"]}
            isEmpty={outlets.length === 0}
            empty="No outlets."
          >
            {outlets.map((o) => (
              <tr key={o.id}>
                <Cell>
                  {o.name}
                  <p className="text-muted-foreground text-xs">{o.slug}</p>
                </Cell>
                <Cell>
                  <StatusBadge value={o.status} />
                </Cell>
                <Cell>{o.currency_code}</Cell>
                <Cell>{o.timezone}</Cell>
              </tr>
            ))}
          </DataTable>
        </Section>

        <Section
          title="Staff memberships"
          description="Deactivating removes one person's access to this business. It does not change the business status."
        >
          <DataTable
            headers={["Person", "Role", "Status", ""]}
            isEmpty={members.length === 0}
            empty="No memberships."
          >
            {members.map((m) => (
              <tr key={m.membership_id}>
                <Cell>
                  <Link
                    className="underline-offset-4 hover:underline"
                    href={`/admin/users/${m.user_id}`}
                  >
                    {m.full_name || m.email || "Unnamed"}
                  </Link>
                  <p className="text-muted-foreground text-xs">{m.email}</p>
                </Cell>
                <Cell>{m.role}</Cell>
                <Cell>
                  <StatusBadge value={m.status} />
                </Cell>
                <Cell>
                  {canTenants && m.status === "active" ? (
                    <DeactivateMembershipForm membershipId={m.membership_id} />
                  ) : null}
                </Cell>
              </tr>
            ))}
          </DataTable>
        </Section>
      </div>

      <Section
        title="Usage (last 30 days)"
        description="Counts from the database for this business. Storage and API calls are not measured in this phase."
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Outlets" value={usage.outlets} />
          <Metric label="Active staff" value={usage.active_staff} />
          <Metric
            label="Orders"
            value={usage.orders}
            note={`${usage.channel_orders} from online or QR channels`}
          />
          <Metric
            label="Last order (all time)"
            value={usage.last_order_at ? formatDateTime(usage.last_order_at) : "No orders yet"}
          />
          <Metric label="Payments captured" value={usage.payments_captured} />
          <Metric
            label="Captured value"
            value={
              usage.payments_captured_minor_by_currency.length === 0
                ? "None"
                : usage.payments_captured_minor_by_currency
                    .map((c) => formatCurrencyMinor(c.currency_code, c.minor))
                    .join(" · ")
            }
          />
          <Metric
            label="Integration jobs"
            value={usage.integration_jobs}
            note={`${usage.integration_jobs_dead} dead`}
          />
          <Metric label="Customers (all time)" value={usage.customers_all_time} />
          <Metric label="Storage used" value={null} note="Not measured" />
        </div>
      </Section>

      <Section
        title="Tenant activity"
        description="Changes made inside this business. Reads are not logged per access. Operators' own changes appear in the audit log."
      >
        <FilterBar submitLabel="Filter">
          <Field label="Action prefix" hint="For example: order. or member.">
            <input name="prefix" defaultValue={prefix} className={adminInputClass} />
          </Field>
        </FilterBar>
        <DataTable
          headers={["When", "Action", "Target", "Actor"]}
          isEmpty={activity.rows.length === 0}
          empty="No matching activity."
        >
          {activity.rows.map((row) => (
            <tr key={row.id}>
              <Cell>{formatDateTime(row.created_at)}</Cell>
              <Cell className="font-mono text-xs">{row.action}</Cell>
              <Cell className="text-xs">{row.target_type}</Cell>
              <Cell className="text-xs">{row.actor_email ?? "System"}</Cell>
            </tr>
          ))}
        </DataTable>
        <p className="text-muted-foreground text-xs">
          Showing {activity.rows.length} of {activity.total} events.
        </p>
      </Section>
    </div>
  );
}
