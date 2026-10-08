"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetPasswordAction } from "@/modules/auth/actions";
import { FieldError, FormError, SubmitButton } from "@/modules/auth/components/form-bits";

export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState(resetPasswordAction, undefined);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError state={state} />

      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          aria-describedby="reset-rules"
          required
        />
        <p id="reset-rules" className="text-xs text-muted-foreground">
          At least 8 characters with one letter and one number.
        </p>
        <FieldError state={state} name="password" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        <FieldError state={state} name="confirm" />
      </div>

      <SubmitButton label="Set new password" busyLabel="Saving…" pending={pending} />
    </form>
  );
}
