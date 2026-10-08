"use client";

import { Loader2 } from "lucide-react";
import type { AuthActionState } from "@/modules/auth/actions";
import { Button } from "@/components/ui/button";

/** First validation message for a field, if any. */
export function FieldError({ state, name }: { state: AuthActionState | undefined; name: string }) {
  const message = state?.fieldErrors?.[name]?.[0];
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/** Form-level error banner. */
export function FormError({ state }: { state: AuthActionState | undefined }) {
  if (!state?.error) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
    >
      {state.error}
    </div>
  );
}

/** Success note (e.g. profile saved). */
export function FormSuccess({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-gold/40 bg-gold/10 px-3 py-2.5 text-sm text-foreground"
    >
      {message}
    </div>
  );
}

/** Submit button with a pending spinner. */
export function SubmitButton({
  label,
  busyLabel,
  pending,
}: {
  label: string;
  busyLabel: string;
  pending: boolean;
}) {
  return (
    <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
      {pending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
      {pending ? busyLabel : label}
    </Button>
  );
}
