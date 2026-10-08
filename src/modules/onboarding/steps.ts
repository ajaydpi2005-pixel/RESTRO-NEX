/**
 * Phase 6 — Onboarding step registry.
 *
 * The wizard order mirrors the product flow:
 *   signup → verify → business → type → outlet → settings → tax →
 *   tables → kitchen → menu → staff → dashboard
 *
 * "business" is implicit (the tenant row existing means it is done), "finish"
 * is the completion screen that stamps completed_at. Steps marked skippable
 * can be deferred without blocking completion; prerequisites are enforced
 * server-side when a step renders.
 */

export const ONBOARDING_STEPS = [
  "business",
  "type",
  "outlet",
  "settings",
  "tax",
  "tables",
  "kitchen",
  "menu",
  "staff",
  "finish",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** Step slugs the DB column also accepts (adds the terminal "done"). */
export const DB_STEP_VALUES = [...ONBOARDING_STEPS, "done"] as const;

export interface OnboardingStepMeta {
  id: OnboardingStepId;
  label: string;
  title: string;
  description: string;
  /** Skippable steps can be deferred; required ones gate completion. */
  skippable: boolean;
  /** Steps that must be completed before this one makes sense. */
  prerequisites: readonly OnboardingStepId[];
}

export const ONBOARDING_STEP_META: Record<OnboardingStepId, OnboardingStepMeta> = {
  business: {
    id: "business",
    label: "Business",
    title: "Create your business",
    description: "The home for your restaurants — you can add more outlets later.",
    skippable: false,
    prerequisites: [],
  },
  type: {
    id: "type",
    label: "Restaurant type",
    title: "What kind of restaurant is this?",
    description: "We use this to tailor defaults across the platform.",
    skippable: false,
    prerequisites: ["business"],
  },
  outlet: {
    id: "outlet",
    label: "First outlet",
    title: "Add your first outlet",
    description: "An outlet is a physical location that takes orders.",
    skippable: false,
    prerequisites: ["business"],
  },
  settings: {
    id: "settings",
    label: "Business settings",
    title: "Business settings",
    description: "Contact details, address, currency and timezone.",
    skippable: true,
    prerequisites: ["business"],
  },
  tax: {
    id: "tax",
    label: "Tax",
    title: "Tax settings",
    description: "Your tax registration and the rates printed on bills.",
    skippable: true,
    prerequisites: ["business"],
  },
  tables: {
    id: "tables",
    label: "Tables",
    title: "Set up your tables",
    description: "Sections and tables for dine-in orders.",
    skippable: true,
    prerequisites: ["business", "outlet"],
  },
  kitchen: {
    id: "kitchen",
    label: "Kitchen",
    title: "Kitchen stations",
    description: "Stations that receive kitchen order tickets.",
    skippable: true,
    prerequisites: ["business", "outlet"],
  },
  menu: {
    id: "menu",
    label: "Menu",
    title: "Create your menu",
    description: "Categories and dishes — you can refine everything later.",
    skippable: true,
    prerequisites: ["business"],
  },
  staff: {
    id: "staff",
    label: "Staff",
    title: "Invite your staff",
    description: "Send invitation links to the people who will run the floor.",
    skippable: true,
    prerequisites: ["business"],
  },
  finish: {
    id: "finish",
    label: "Finish",
    title: "You're all set",
    description: "Review what you've configured and open your dashboard.",
    skippable: false,
    prerequisites: ["business", "type", "outlet"],
  },
};

export function isOnboardingStep(value: unknown): value is OnboardingStepId {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/** 0-based position of a step in the wizard. */
export function stepIndex(step: OnboardingStepId): number {
  return ONBOARDING_STEPS.indexOf(step);
}

/**
 * The first uncompleted step to show when resuming. `completed` may include
 * "business"; the terminal "finish" completion is represented by completed_at.
 */
export function nextIncompleteStep(completed: readonly string[]): OnboardingStepId {
  for (const step of ONBOARDING_STEPS) {
    if (!completed.includes(step)) return step;
  }
  return "finish";
}

/**
 * Where a deep link / resume should land: the requested step if it is valid
 * and its prerequisites are done, otherwise the first step that still needs
 * work (never a step the user isn't ready for).
 */
export function resolveStep(
  requested: unknown,
  completed: readonly string[],
): OnboardingStepId {
  if (isOnboardingStep(requested)) {
    const meta = ONBOARDING_STEP_META[requested];
    const ready = meta.prerequisites.every((pre) => completed.includes(pre));
    if (ready) return requested;
  }
  return nextIncompleteStep(completed);
}

/** Overall progress percentage for the indicator. */
export function completionPercent(completed: readonly string[]): number {
  const done = ONBOARDING_STEPS.filter((step) => completed.includes(step)).length;
  return Math.round((done / ONBOARDING_STEPS.length) * 100);
}

/** Next step after saving `current` (used by save & continue). */
export function stepAfter(current: OnboardingStepId): OnboardingStepId {
  const index = stepIndex(current);
  const next = ONBOARDING_STEPS[index + 1];
  return next ?? "finish";
}

export type StepVisualState = "done" | "current" | "skipped" | "upcoming";

/**
 * Visual state of each step for the progress rail. A skippable step becomes
 * "skipped" when the wizard has moved past it without completion.
 */
export function stepStates(
  current: OnboardingStepId,
  completed: readonly string[],
): Record<OnboardingStepId, StepVisualState> {
  const currentIndex = stepIndex(current);
  const states = {} as Record<OnboardingStepId, StepVisualState>;
  for (const step of ONBOARDING_STEPS) {
    if (completed.includes(step)) {
      states[step] = "done";
    } else if (step === current) {
      states[step] = "current";
    } else if (stepIndex(step) < currentIndex && ONBOARDING_STEP_META[step].skippable) {
      states[step] = "skipped";
    } else {
      states[step] = "upcoming";
    }
  }
  return states;
}
