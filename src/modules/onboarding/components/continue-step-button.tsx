"use client";

import { useActionState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { continueOnboardingStepAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import { FormError } from "@/components/forms/form-bits";

/** Advance past a step whose work saves separately (e.g. staff invites). */
export function ContinueStepButton({ businessId, step }: { businessId: string; step: string }) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    continueOnboardingStepAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="step" value={step} />
      <FormError state={state} />
      <Button type="submit" disabled={pending} className="w-full sm:w-auto sm:px-6">
        {pending ? "Saving…" : "Save & continue"} <ArrowRight className="size-4" aria-hidden />
      </Button>
    </form>
  );
}
