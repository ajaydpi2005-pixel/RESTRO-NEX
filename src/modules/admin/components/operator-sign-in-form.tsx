"use client";

import { useActionState } from "react";
import { FormError, SubmitButton } from "@/components/forms/form-bits";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { operatorSignInAction, type OperatorSignInState } from "../auth-actions";

/**
 * Operator sign-in. Separate from the restaurant sign-in page on purpose: the
 * action refuses any account that is not an operator and signs it out again.
 */
export function OperatorSignInForm() {
  const [state, formAction, pending] = useActionState<OperatorSignInState | undefined, FormData>(
    operatorSignInAction,
    undefined,
  );
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="operator-email">Operator email</Label>
        <Input id="operator-email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="operator-password">Password</Label>
        <Input
          id="operator-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <FormError state={state} />
      <SubmitButton label="Sign in to Super Admin" busyLabel="Signing in…" pending={pending} />
    </form>
  );
}
