"use client";

import Link from "next/link";
import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signUpAction } from "@/modules/auth/actions";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUpAction, undefined);

  if (state?.needsVerification) {
    return (
      <div className="space-y-4 text-center">
        <MailCheck aria-hidden className="mx-auto size-8 text-gold-deep dark:text-gold" />
        <p className="text-sm font-medium">Check your email</p>
        <p className="text-sm text-muted-foreground">
          We&apos;ve sent a confirmation link. Click it to activate your account, then sign in.
          The link expires after one hour.
        </p>
        <Link
          href="/login"
          className="inline-block text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError state={state} />

      <div className="space-y-1.5">
        <Label htmlFor="fullName">Full name</Label>
        <Input id="fullName" name="fullName" autoComplete="name" placeholder="Alex Fernandez" />
        <FieldError state={state} name="fullName" />
      </div>

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

      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          aria-describedby="password-rules"
          required
        />
        <p id="password-rules" className="text-xs text-muted-foreground">
          At least 8 characters with one letter and one number.
        </p>
        <FieldError state={state} name="password" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        <FieldError state={state} name="confirm" />
      </div>

      <SubmitButton label="Create account" busyLabel="Creating account…" pending={pending} />

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
