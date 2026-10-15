import type { Metadata } from "next";
import { operatorCan } from "@/modules/admin/access";
import { PlanForm } from "@/modules/admin/components/admin-forms";
import { PageHeader, ReadOnlyNote, Section } from "@/modules/admin/components/admin-ui";
import { loadPlans } from "@/modules/admin/queries";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Plans" };

export default async function PlansPage() {
  const op = await requireOperator("view");
  const canEdit = operatorCan(op.permissions, "plans");
  const plans = await loadPlans();
  const catalog = plans[0]?.features ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plans"
        description="Plan limits and included features. These are placeholder values until the business sets its final prices. Each change applies to every business on the plan immediately."
      />

      {!canEdit ? <ReadOnlyNote /> : null}

      {plans.map((plan) => (
        <Section
          key={plan.code}
          title={`${plan.name} (${plan.code})`}
          description={`${plan.businesses} business${plan.businesses === 1 ? "" : "es"} on this plan${plan.is_active ? "" : " · not offered to new businesses"}`}
        >
          {canEdit ? (
            <PlanForm plan={plan} catalog={catalog} />
          ) : (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {plan.features.map((f) => (
                <div key={f.feature_key}>
                  <dt className="text-muted-foreground text-xs">{f.label}</dt>
                  <dd>
                    {f.included
                      ? f.kind === "limit"
                        ? (f.limit_value ?? "Unlimited")
                        : "On"
                      : "Off"}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Section>
      ))}

      {canEdit && catalog.length > 0 ? (
        <Section
          title="New plan"
          description="Create a plan with a new code. Existing businesses are not moved to it."
        >
          <PlanForm catalog={catalog.map((f) => ({ ...f, included: false, limit_value: null }))} />
        </Section>
      ) : null}
    </div>
  );
}
