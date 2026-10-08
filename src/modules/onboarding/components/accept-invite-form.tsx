"use client";

import { useActionState } from "react";
import { acceptStaffInviteAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import { FormError, SubmitButton } from "@/components/forms/form-bits";

export function AcceptInviteForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    acceptStaffInviteAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <FormError state={state} />
      <SubmitButton label="Accept invitation" busyLabel="Accepting…" pending={pending} />
    </form>
  );
}
