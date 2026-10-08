import type { ReactNode } from "react";
import Link from "next/link";
import {
  BookOpen,
  Building2,
  Check,
  Flag,
  Flame,
  LayoutGrid,
  ReceiptText,
  Settings2,
  Store,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_META,
  completionPercent,
  stepStates,
  type OnboardingStepId,
} from "@/modules/onboarding/steps";

/**
 * Phase 6 — Immersive wizard shell: dark progress rail (brand ink) beside a
 * calm cream workspace. Server component; state comes from the DB so resume
 * works without any client bookkeeping.
 */

const STEP_ICONS: Record<OnboardingStepId, typeof Building2> = {
  business: Building2,
  type: UtensilsCrossed,
  outlet: Store,
  settings: Settings2,
  tax: ReceiptText,
  tables: LayoutGrid,
  kitchen: Flame,
  menu: BookOpen,
  staff: Users,
  finish: Flag,
};

export function OnboardingShell({
  currentStep,
  completedSteps,
  businessName,
  children,
}: {
  currentStep: OnboardingStepId;
  completedSteps: readonly string[];
  businessName: string | null;
  children: ReactNode;
}) {
  const states = stepStates(currentStep, completedSteps);
  const percent = completionPercent(completedSteps);

  const rail = (
    <ol className="space-y-1" aria-label="Onboarding steps">
      {ONBOARDING_STEPS.map((step, index) => {
        const state = states[step];
        const Icon = STEP_ICONS[step];
        return (
          <li key={step}>
            <div
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                state === "current" && "bg-white/10 text-gold-bright",
                state === "done" && "text-cream",
                state === "skipped" && "text-cream/50",
                state === "upcoming" && "text-cream/60",
              )}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs",
                  state === "done" && "border-gold bg-gold text-ink",
                  state === "current" && "border-gold text-gold",
                  (state === "upcoming" || state === "skipped") && "border-cream/25 text-cream/60",
                )}
              >
                {state === "done" ? <Check className="size-3.5" aria-hidden /> : index + 1}
              </span>
              <span className="flex items-center gap-2">
                <Icon className="size-4 shrink-0" aria-hidden />
                {ONBOARDING_STEP_META[step].label}
                {state === "skipped" ? <span className="text-[11px] uppercase tracking-wide">· skipped</span> : null}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );

  return (
    <div className="min-h-dvh bg-cream text-ink lg:grid lg:grid-cols-[320px_1fr]">
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-dvh flex-col gap-8 overflow-y-auto bg-ink p-8 text-cream lg:flex">
        <div>
          <p className="font-display text-xl font-semibold tracking-tight">
            Restro<span className="text-gold">Nex</span>
          </p>
          <p className="mt-1 text-xs text-cream/60">Restaurant setup</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-cream/70">
            <span className="truncate pr-2">{businessName ?? "Your restaurant"}</span>
            <span className="tabular-nums text-gold-bright">{percent}%</span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Onboarding progress"
          >
            <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${percent}%` }} />
          </div>
        </div>

        <nav className="flex-1">{rail}</nav>

        <p className="text-[11px] leading-relaxed text-cream/40">
          Your progress is saved automatically — leave any time and pick up where you left off.
        </p>
      </aside>

      {/* Mobile header + content */}
      <div className="flex min-w-0 flex-col">
        <header className="border-b border-ink/10 bg-ink px-5 py-4 text-cream lg:hidden">
          <div className="flex items-center justify-between gap-3">
            <p className="font-display text-lg font-semibold">
              Restro<span className="text-gold">Nex</span>
            </p>
            <p className="text-xs tabular-nums text-gold-bright">{percent}% complete</p>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gold" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-2 text-xs text-cream/70">
            Step {ONBOARDING_STEPS.indexOf(currentStep) + 1} of {ONBOARDING_STEPS.length} ·{" "}
            {ONBOARDING_STEP_META[currentStep].label}
          </p>
        </header>

        <main className="flex flex-1 justify-center px-5 py-10 sm:px-8 lg:py-14">
          <div className="w-full max-w-xl">{children}</div>
        </main>

        <footer className="px-5 pb-8 text-center text-xs text-ink/40 lg:hidden">
          Progress saves automatically — resume any time.
        </footer>
      </div>
    </div>
  );
}

/** Step card frame used by every wizard page. */
export function StepCard({
  step,
  children,
}: {
  step: OnboardingStepId;
  children: ReactNode;
}) {
  const meta = ONBOARDING_STEP_META[step];
  return (
    <section className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{meta.title}</h1>
        <p className="text-sm text-muted-foreground">{meta.description}</p>
      </header>
      {children}
    </section>
  );
}

/** Back link shown under every step form. */
export function StepNavBack({ previousStep }: { previousStep: OnboardingStepId | null }) {
  if (!previousStep) return null;
  return (
    <Link
      href={`/onboarding/${previousStep}`}
      className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-ink hover:underline"
    >
      ← Back to {ONBOARDING_STEP_META[previousStep].label.toLowerCase()}
    </Link>
  );
}
