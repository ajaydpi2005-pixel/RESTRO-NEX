"use client";

import Link from "next/link";
import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgotPasswordAction } from "@/modules/auth/actions";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(forgotPasswordAction, undefined);

  if (state?.ok) {
    return (
      <div className="space-y-4 text-center">
        <MailCheck aria-hidden className="mx-auto size-8 text-gold-deep dark:text-gold" />
        <p className="text-sm text-muted-foreground">
          If an account exists for that email, a password reset link is on its way. Check your
          inbox — and the spam folder, just in case.
        </p>
        <Link
          href="/login"
          className="inline-block text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError state={state} />

      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@restaurant.com"
          required
        />
        <FieldError state={state} name="email" />
      </div>

      <SubmitButton label="Send reset link" busyLabel="Sending…" pending={pending} />

      <p className="text-center text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
