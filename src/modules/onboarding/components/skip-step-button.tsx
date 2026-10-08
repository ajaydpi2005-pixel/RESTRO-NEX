"use client";

import { useActionState } from "react";
import { skipOnboardingStepAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import { FormError } from "@/components/forms/form-bits";

/** "Skip for now" — defers a skippable step without marking it done. */
export function SkipStepButton({ businessId, step }: { businessId: string; step: string }) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    skipOnboardingStepAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="step" value={step} />
      <FormError state={state} />
      <button
        type="submit"
        disabled={pending}
        className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-ink hover:underline disabled:opacity-50"
      >
        {pending ? "Skipping…" : "Skip for now"}
      </button>
    </form>
  );
}
