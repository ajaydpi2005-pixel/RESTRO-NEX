"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInAction } from "@/modules/auth/actions";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

export function SignInForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(signInAction, undefined);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError state={state} />
      <input type="hidden" name="next" value={next} />

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
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            href="/forgot-password"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Forgot password?
          </Link>
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <FieldError state={state} name="password" />
      </div>

      <SubmitButton label="Sign in" busyLabel="Signing in…" pending={pending} />

      <p className="text-center text-sm text-muted-foreground">
        New to RestroNex?{" "}
        <Link href="/signup" className="font-medium text-foreground underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
