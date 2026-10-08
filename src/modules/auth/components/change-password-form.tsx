"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction } from "@/modules/auth/actions";
import {
  FieldError,
  FormError,
  FormSuccess,
  SubmitButton,
} from "@/modules/auth/components/form-bits";

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, undefined);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Password updated." : undefined} />

      <div className="space-y-1.5">
        <Label htmlFor="current">Current password</Label>
        <Input id="current" name="current" type="password" autoComplete="current-password" required />
        <FieldError state={state} name="current" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          aria-describedby="change-rules"
          required
        />
        <p id="change-rules" className="text-xs text-muted-foreground">
          At least 8 characters with one letter and one number.
        </p>
        <FieldError state={state} name="password" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        <FieldError state={state} name="confirm" />
      </div>

      <SubmitButton label="Update password" busyLabel="Updating…" pending={pending} />
    </form>
  );
}
