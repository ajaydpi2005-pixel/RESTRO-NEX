import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, CircleDashed } from "lucide-react";
import { assignableRoles, canAssignRole, isRole } from "@/lib/rbac/permissions";
import { OnboardingShell, StepCard, StepNavBack } from "@/modules/onboarding/components/onboarding-shell";
import { CreateBusinessForm } from "@/modules/onboarding/components/create-business-form";
import { RestaurantTypeForm } from "@/modules/onboarding/components/restaurant-type-form";
import { OutletStepForm } from "@/modules/onboarding/components/outlet-step-form";
import { SettingsStepForm } from "@/modules/onboarding/components/settings-step-form";
import { TaxStepForm } from "@/modules/onboarding/components/tax-step-form";
import { TablesStepForm } from "@/modules/onboarding/components/tables-step-form";
import { KitchenStepForm } from "@/modules/onboarding/components/kitchen-step-form";
import { MenuStepForm } from "@/modules/onboarding/components/menu-step-form";
import { PendingInvitesList, StaffInviteForm } from "@/modules/onboarding/components/staff-step";
import { FinishButton } from "@/modules/onboarding/components/finish-step";
import { SkipStepButton } from "@/modules/onboarding/components/skip-step-button";
import { ContinueStepButton } from "@/modules/onboarding/components/continue-step-button";
import {
  getOnboardingContext,
  loadFloorPlan,
  loadKitchenStations,
  loadMenu,
  loadOnboardingCounts,
  loadOutlets,
  loadPendingInvites,
} from "@/modules/onboarding/queries";
import {
  isOnboardingStep,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_META,
  resolveStep,
  type OnboardingStepId,
} from "@/modules/onboarding/steps";
import { RESTAURANT_TYPE_LABELS } from "@/modules/business/schemas";
import { Badge } from "@/components/ui/badge";
import { guardRedirect } from "@/lib/guarded-redirect";

export const metadata: Metadata = { title: "Set up your restaurant" };

export default async function OnboardingStepPage({
  params,
}: {
  params: Promise<{ step: string }>;
}) {
  const { step: rawStep } = await params;
  const context = await getOnboardingContext();

  if (!context.userId) return await guardRedirect("/login?next=/onboarding");

  // No business yet → the only meaningful step is creating one.
  if (!context.business) {
    if (rawStep !== "business") return await guardRedirect("/onboarding/business");
    return (
      <OnboardingShell currentStep="business" completedSteps={[]} businessName={null}>
        <StepCard step="business">
          <CreateBusinessForm />
        </StepCard>
      </OnboardingShell>
    );
  }

  // Onboarding already finished for every business this user manages.
  if (context.progress?.completedAt) return await guardRedirect("/dashboard");

  const business = context.business;
  const outlets = await loadOutlets(business.id);

  // Derived completions keep the rail honest even if progress is stale.
  const completed = new Set(context.progress?.completedSteps ?? []);
  completed.add("business");
  if (business.restaurantType) completed.add("type");
  if (outlets.length > 0) completed.add("outlet");
  const completedList = [...completed];

  const step: OnboardingStepId = isOnboardingStep(rawStep) ? rawStep : "business";
  if (step === "business") return await guardRedirect(`/onboarding/${resolveStep("type", completedList)}`);

  const resolved = resolveStep(step, completedList);
  if (resolved !== step) return await guardRedirect(`/onboarding/${resolved}`);

  // ── step content ──────────────────────────────────────────────────────────
  const previousIndex = ONBOARDING_STEPS.indexOf(step) - 1;
  const previousStep = (previousIndex >= 0 ? ONBOARDING_STEPS[previousIndex] : null) ?? null;
  const skippable = ONBOARDING_STEP_META[step].skippable;

  let content: React.ReactNode = null;
  let footer: React.ReactNode = null;

  switch (step) {
    case "type":
      content = <RestaurantTypeForm businessId={business.id} initialType={business.restaurantType} />;
      break;
    case "outlet":
      content = <OutletStepForm businessId={business.id} />;
      break;
    case "settings":
      content = <SettingsStepForm business={business} />;
      break;
    case "tax":
      content = <TaxStepForm business={business} />;
      break;
    case "tables": {
      const outlet = outlets[0];
      const sections = outlet ? await loadFloorPlan(outlet.id) : [];
      content = (
        <TablesStepForm
          businessId={business.id}
          outlets={outlets}
          existing={outlet ? { outletId: outlet.id, sections } : null}
        />
      );
      break;
    }
    case "kitchen": {
      const outlet = outlets[0];
      const stations = outlet ? await loadKitchenStations(outlet.id) : [];
      content = (
        <KitchenStepForm
          businessId={business.id}
          outlets={outlets}
          existing={outlet ? { outletId: outlet.id, stations } : null}
        />
      );
      break;
    }
    case "menu":
      content = <MenuStepForm businessId={business.id} existing={await loadMenu(business.id)} />;
      break;
    case "staff": {
      const actorRole = context.role && isRole(context.role) ? context.role : null;
      const roles = actorRole
        ? assignableRoles(actorRole).filter((role) => role !== "owner" && canAssignRole(actorRole, role))
        : [];
      content = (
        <div className="space-y-8">
          <StaffInviteForm businessId={business.id} assignableRoles={roles} outlets={outlets} />
          <div className="space-y-3">
            <h2 className="text-sm font-medium">Pending invitations</h2>
            <PendingInvitesList businessId={business.id} invites={await loadPendingInvites(business.id)} />
          </div>
        </div>
      );
      break;
    }
    case "finish": {
      const counts = await loadOnboardingCounts(business.id, outlets);
      const rows: { label: string; done: boolean; value: string; href?: string }[] = [
        { label: "Business", done: true, value: business.name },
        {
          label: "Restaurant type",
          done: Boolean(business.restaurantType),
          value: business.restaurantType
            ? RESTAURANT_TYPE_LABELS[business.restaurantType as keyof typeof RESTAURANT_TYPE_LABELS] ?? business.restaurantType
            : "Not set",
          href: "/onboarding/type",
        },
        {
          label: "Outlets",
          done: counts.outlets > 0,
          value: `${counts.outlets} outlet${counts.outlets === 1 ? "" : "s"}`,
          href: "/onboarding/outlet",
        },
        {
          label: "Tables",
          done: counts.tables > 0,
          value: counts.tables > 0 ? `${counts.tables} tables` : "Skipped — add any time",
          href: "/onboarding/tables",
        },
        {
          label: "Kitchen stations",
          done: counts.kitchenStations > 0,
          value: counts.kitchenStations > 0 ? `${counts.kitchenStations} stations` : "Skipped — add any time",
          href: "/onboarding/kitchen",
        },
        {
          label: "Menu",
          done: counts.menuItems > 0,
          value: counts.menuItems > 0 ? `${counts.menuItems} items` : "Skipped — add any time",
          href: "/onboarding/menu",
        },
        {
          label: "Staff invitations",
          done: counts.pendingInvites > 0,
          value: counts.pendingInvites > 0 ? `${counts.pendingInvites} pending` : "Skipped — invite any time",
          href: "/onboarding/staff",
        },
      ];
      content = (
        <div className="space-y-6">
          <ul className="divide-y divide-ink/10 overflow-hidden rounded-xl border border-ink/10 bg-white">
            {rows.map((row) => (
              <li key={row.label} className="flex items-center gap-3 px-4 py-3 text-sm">
                {row.done ? (
                  <CircleCheck className="size-4.5 shrink-0 text-gold-deep" aria-hidden />
                ) : (
                  <CircleDashed className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="w-36 shrink-0 text-muted-foreground">{row.label}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{row.value}</span>
                {!row.done && row.href ? (
                  <Link href={row.href} className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-ink hover:underline">
                    Add now
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="rounded-xl border border-gold/50 bg-gold/10 p-4 text-sm">
            You can change everything later from Settings, the menu manager and staff management.
          </div>
          <FinishButton businessId={business.id} />
        </div>
      );
      break;
    }
    default:
      return await guardRedirect("/onboarding");
  }

  footer = (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <StepNavBack previousStep={previousStep} />
      <div className="flex flex-wrap items-center gap-4">
        {skippable ? (
          <SkipStepButton businessId={business.id} step={step} />
        ) : (
          <Badge variant="outline" className="border-ink/15 text-muted-foreground">
            Required
          </Badge>
        )}
        {step === "staff" ? <ContinueStepButton businessId={business.id} step={step} /> : null}
      </div>
    </div>
  );

  return (
    <OnboardingShell currentStep={step} completedSteps={completedList} businessName={business.name}>
      <StepCard step={step}>
        {content}
        {footer}
      </StepCard>
    </OnboardingShell>
  );
}
