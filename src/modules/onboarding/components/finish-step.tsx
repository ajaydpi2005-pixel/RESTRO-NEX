"use client";

import { useActionState } from "react";
import { finishOnboardingAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import { FormError, SubmitButton } from "@/components/forms/form-bits";

export function FinishButton({ businessId }: { businessId: string }) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    finishOnboardingAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />
      <SubmitButton label="Finish setup & open dashboard" busyLabel="Finishing…" pending={pending} />
    </form>
  );
}
